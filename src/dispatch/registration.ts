import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { parseQueueAddress, formatQueueAddress } from '@shared/queue-identity.js'
import type { DispatchInput, DispatchProfileConfig } from '@shared/queue-dispatch.js'
import type { DispatchAuth } from './auth.js'
import type { DispatchActor } from './ports.js'
import type { ExecutorSession, ExecutorHeartbeat, RegisterExecutorInput, SlotInput, DispatchSlotView } from './client.js'
import type { ManagedSlotConfig } from './eligibility.js'
import { withDispatchRetryTransaction, type DispatchStore } from './db.js'
import { DispatchError } from './errors.js'
import { isManagedWorkerInstanceId } from '../presence/worker-mode.js'
import { credentialMatches } from './credentials.js'

type Profile = { id: string; product_id: string; config: DispatchProfileConfig; sha256: string; revoked_at: Date | null }
export type IncarnationScope = ManagedSlotConfig & { profile_revision_ids: string[]; image_digest: string; profile_sha256: string; supervisor_token_id: string }
const forbidden = (): never => { throw new DispatchError('DISPATCH_FORBIDDEN') }
const conflict = (): never => { throw new DispatchError('DISPATCH_STATE_CONFLICT') }
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const keyValid = (s: string) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s)
export function parseManagedSlotConfig(value: unknown): ManagedSlotConfig {
  const c = value as ManagedSlotConfig
  if (!c || typeof c !== 'object' || Object.keys(c).sort().join(',') !== 'capabilities,product_ids,runtime,tier,version,worker_instance_id'
    || c.version !== 1 || !['CODEX', 'CLAUDE'].includes(c.runtime) || !Array.isArray(c.product_ids) || !c.product_ids.length
    || c.product_ids.some(x => typeof x !== 'string' || !x) || !Array.isArray(c.capabilities) || c.capabilities.some(x => typeof x !== 'string' || !x)
    || (c.tier !== null && !['HIGH_P', 'MEDIUM_P', 'LOW_P'].includes(c.tier))
    || (c.worker_instance_id !== null && !isManagedWorkerInstanceId(c.worker_instance_id))) throw new DispatchError('DISPATCH_INVALID_INPUT')
  return c
}
export function actorForToken(userId: string, tokenId: string): DispatchActor {
  return { userId, tokenId, principalKey: `bearer:${userId}:${tokenId}`, source: 'bearer', isDemo: false, scopedProducts: [], scopedRepos: [], tokenKind: null }
}
/** Read-only authentication, reusable after the caller's ordered slot locks. */
export async function authenticateExecutorSession(db: PoolClient, auth: DispatchAuth, actor: DispatchActor, incarnationId: string, sessionCredential: string) {
  const current = await auth.refreshActor(actor, db)
  const row = (await db.query<{ id: string; slot_id: string; boot_id: string; credential_hash: string; signed_off_at: Date | null; runtime_scope: IncarnationScope; owner_user_id: string; token_id: string; enabled: boolean }>(
    `SELECT i.*,s.owner_user_id,s.token_id,s.enabled FROM queue_dispatch_incarnations i JOIN queue_dispatch_slots s ON s.id=i.slot_id WHERE i.id=$1`, [incarnationId])).rows[0]
  if (!row || current.source !== 'bearer' || current.userId !== row.owner_user_id || current.tokenId !== row.token_id
    || row.runtime_scope.supervisor_token_id !== current.tokenId || row.signed_off_at || !row.enabled
    || !credentialMatches(sessionCredential, row.credential_hash)) return forbidden()
  return row
}
/** A minimal read-only envelope that carries only the product whose rights are being checked. */
export const productInput = (productId: string): DispatchInput => ({ version: 1, product_id: productId, action: 'free_task', objective: 'Slot authorization', verification: 'Current rights', response_format: 'Markdown', requirements: { access: 'read', environment_keys: [] }, publish: 'artifact', reply_to: 'mac:jp' })
export function createDispatchRegistration(deps: { store: DispatchStore; auth: DispatchAuth; credentialKeys: Record<number, Uint8Array>; keyVersion: number }) {
  if (!Number.isInteger(deps.keyVersion) || deps.keyVersion < 1 || !deps.credentialKeys[deps.keyVersion] || Object.values(deps.credentialKeys).some(k => k.byteLength < 32)) throw new DispatchError('DISPATCH_ASSERTION_KEY_INVALID')
  function credential(id: string, slotId: string, tokenId: string, version: number) {
    const key = deps.credentialKeys[version]; if (!key) return forbidden()
    return createHmac('sha256', key).update(JSON.stringify(['dispatch-session-v1', id, slotId, tokenId, version])).digest('base64url')
  }
  async function profiles(db: PoolClient, ids: string[], includeRevoked = false) {
    const rows = (await db.query<Profile>('SELECT id,product_id,config,sha256,revoked_at FROM queue_dispatch_profiles WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows
    if (!ids.length || rows.length !== new Set(ids).size || (!includeRevoked && rows.some(p => p.revoked_at))) return forbidden()
    return rows
  }
  async function slotAuthorization(db: PoolClient, actor: DispatchActor, slotId: string) {
    const current = await deps.auth.refreshActor(actor, db)
    if (current.source !== 'bearer' || !current.tokenId) return forbidden()
    const slot = (await db.query<{ id: string; owner_user_id: string; token_id: string; enabled: boolean; config: unknown; kind: 'job' | 'host'; address: string | null }>(
      'SELECT * FROM queue_dispatch_slots WHERE id=$1 FOR UPDATE', [slotId])).rows[0]
    if (!slot || !slot.enabled || slot.owner_user_id !== current.userId || slot.token_id !== current.tokenId) return forbidden()
    const config = parseManagedSlotConfig(slot.config)
    if (slot.kind === 'job' && !isManagedWorkerInstanceId(config.worker_instance_id)) return forbidden()
    const ids = (await db.query<{ profile_revision_id: string }>('SELECT profile_revision_id FROM queue_dispatch_slot_profiles WHERE slot_id=$1', [slotId])).rows.map(r => r.profile_revision_id)
    const allowed = (await profiles(db, ids, true)).filter(p => !p.revoked_at)
    if (!allowed.length) return forbidden()
    for (const productId of config.product_ids) await deps.auth.authorizeDispatch(current, productInput(productId), 'claim', db)
    return { slot, config, allowed, current }
  }
  async function registerDispatchExecutor(actor: DispatchActor, input: RegisterExecutorInput): Promise<ExecutorSession> {
    if (!keyValid(input.registration_key) || typeof input.slot_id!=='string' || typeof input.boot_id!=='string' || !input.boot_id || input.boot_id.length > 256
      || typeof input.image_digest!=='string' || typeof input.profile_sha256!=='string' || !['CODEX', 'CLAUDE'].includes(input.runtime)
      || !/^sha256:[a-f0-9]{64}$/.test(input.image_digest) || !/^[a-f0-9]{64}$/.test(input.profile_sha256)
      || Object.keys(input).sort().join(',') !== 'boot_id,image_digest,profile_sha256,registration_key,runtime,slot_id') throw new DispatchError('DISPATCH_INVALID_INPUT')
    return withDispatchRetryTransaction(deps.store, async db => {
      const { slot, config, allowed, current } = await slotAuthorization(db, actor, input.slot_id)
      const matched = allowed.filter(p => p.config.runtime === input.runtime && p.sha256 === input.profile_sha256 && p.config.image_digest === input.image_digest)
      if (config.runtime !== input.runtime || !matched.length) return forbidden()
      if (slot.kind === 'job') {
        const worker = (await db.query<{ runtime: string; capabilities: string[]; product_id: string | null }>(
          'SELECT runtime,capabilities,product_id FROM claude_workers WHERE user_id=$1 AND token_id=$2 AND instance_id=$3', [slot.owner_user_id, slot.token_id, config.worker_instance_id])).rows[0]
        if (!worker || worker.runtime !== config.runtime) return forbidden()
      }
      const operationKey = `${current.principalKey}:register:${input.registration_key}`
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operationKey])
      const inputHash = hash(JSON.stringify([input.slot_id, input.boot_id, input.runtime, input.image_digest, input.profile_sha256]))
      const old = (await db.query<{ payload: { input_hash: string; response: { incarnation_id: string; slot_id: string; token_id: string; key_version: number } } }>('SELECT payload FROM queue_dispatch_events WHERE operation_key=$1', [operationKey])).rows[0]
      if (old) {
        if (old.payload.input_hash !== inputHash) throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT')
        const r = old.payload.response
        return { incarnation_id: r.incarnation_id, session_credential: credential(r.incarnation_id, r.slot_id, r.token_id, r.key_version) }
      }
      const id = randomUUID(), version = deps.keyVersion
      const secret = credential(id, slot.id, current.tokenId!, version)
      const scope: IncarnationScope = { ...config, profile_revision_ids: matched.map(p => p.id), image_digest: input.image_digest, profile_sha256: input.profile_sha256, supervisor_token_id: current.tokenId! }
      // Signoff is not stop evidence. Old reservations/attempts remain intact.
      await db.query('UPDATE queue_dispatch_incarnations SET signed_off_at=now() WHERE slot_id=$1 AND signed_off_at IS NULL', [slot.id])
      await db.query(`INSERT INTO queue_dispatch_incarnations(id,slot_id,boot_id,credential_hash,credential_key_version,last_seen_at,runtime_scope)
    VALUES($1,$2,$3,$4,$5,now(),$6::jsonb)`, [id, slot.id, input.boot_id, hash(secret), version, JSON.stringify(scope)])
      if (slot.kind === 'job') await db.query('SELECT public.s4m_dispatch_observe_managed_worker($1::uuid,NULL,NULL,false)', [id])
      await db.query(`INSERT INTO queue_dispatch_events(id,type,actor,payload,action_id,operation_key) VALUES($1,'register',$2::jsonb,$3::jsonb,$4,$5)`,
        [randomUUID(), JSON.stringify({ user_id: current.userId, token_id: current.tokenId }), JSON.stringify({ input_hash: inputHash, response: { incarnation_id: id, slot_id: slot.id, token_id: current.tokenId, key_version: version } }), input.registration_key, operationKey])
      return { incarnation_id: id, session_credential: secret }
    })
  }
  async function heartbeatExecutor(actor: DispatchActor, input: ExecutorHeartbeat): Promise<{ live: boolean }> {
    const keys = Object.keys(input).sort().join(',')
    const observation = input.worker_observation
    if (!['busy,incarnation_id,session_credential','busy,incarnation_id,session_credential,worker_observation'].includes(keys)
      || typeof input.busy !== 'boolean' || (observation !== undefined && (!observation
        || Object.keys(observation).sort().join(',') !== 'observed_at,quota_pct'
        || typeof observation.observed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observation.observed_at)
        || !Number.isFinite(Date.parse(observation.observed_at))
        || (observation.quota_pct !== null && (!Number.isInteger(observation.quota_pct) || observation.quota_pct < 0 || observation.quota_pct > 100))))) throw new DispatchError('DISPATCH_INVALID_INPUT')
    return withDispatchRetryTransaction(deps.store, async db => {
      const row = (await db.query<{ slot_id: string; credential_hash: string; signed_off_at: Date | null; runtime_scope: IncarnationScope }>('SELECT slot_id,credential_hash,signed_off_at,runtime_scope FROM queue_dispatch_incarnations WHERE id=$1', [input.incarnation_id])).rows[0]
      if (!row) return forbidden()
      const { slot } = await slotAuthorization(db, actor, row.slot_id)
      await authenticateExecutorSession(db, deps.auth, actor, input.incarnation_id, input.session_credential)
      if (slot.kind === 'job') {
        await db.query('SELECT public.s4m_dispatch_observe_managed_worker($1::uuid,$2::timestamptz,$3::integer,$4::boolean)',
          [input.incarnation_id, observation?.observed_at ?? null, observation?.quota_pct ?? null, observation !== undefined])
      } else if (observation !== undefined) throw new DispatchError('DISPATCH_INVALID_INPUT')
      const result = await db.query('UPDATE queue_dispatch_incarnations SET last_seen_at=now(),busy=$2 WHERE id=$1 AND signed_off_at IS NULL', [input.incarnation_id, input.busy])
      return { live: result.rowCount === 1 }
    })
  }
  async function createSlot(actor: DispatchActor, input: SlotInput): Promise<DispatchSlotView> {
    if (!keyValid(input.action_id) || typeof input.token_id!=='string' || !input.token_id || typeof input.product_id!=='string' || !input.product_id
      || typeof input.capacity_key!=='string' || !Array.isArray(input.profile_revision_ids) || !input.profile_revision_ids.length || input.profile_revision_ids.some(id=>typeof id!=='string')
      || !['job', 'host'].includes(input.kind)) throw new DispatchError('DISPATCH_INVALID_INPUT')
    let address: string | null = null, capacityKey = input.capacity_key
    if (input.kind === 'host') {
      try { const a = parseQueueAddress(input.address?.trim().toLowerCase() ?? ''); if (!('model' in a) || !['claude', 'codex'].includes(a.model)) throw new Error(); address = formatQueueAddress(a) } catch { throw new DispatchError('DISPATCH_INVALID_INPUT') }
      capacityKey = `host:${address}`; if (input.capacity_key !== capacityKey) throw new DispatchError('DISPATCH_INVALID_INPUT')
    } else if (input.address !== null || !capacityKey.startsWith('job:') || !isManagedWorkerInstanceId(capacityKey.slice(4))) throw new DispatchError('DISPATCH_INVALID_INPUT')
    return withDispatchRetryTransaction(deps.store, async db => {
      await deps.auth.authorizeDispatch(actor, productInput(input.product_id), 'profile', db)
      const ps = await profiles(db, input.profile_revision_ids)
      for (const p of ps) await deps.auth.authorizeDispatch(actor, productInput(p.product_id), 'profile', db)
      const token = (await db.query<{ user_id: string }>('SELECT user_id FROM api_tokens WHERE id=$1', [input.token_id])).rows[0]
      if (!token) return forbidden()
      const target = await deps.auth.refreshActor(actorForToken(token.user_id, input.token_id), db)
      const operationKey = `${actor.principalKey}:slot:${input.action_id}`
      const inputHash = hash(JSON.stringify([input.token_id,input.product_id,input.kind,capacityKey,address,[...input.profile_revision_ids].sort()]))
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[operationKey])
      const old = (await db.query<{payload:{input_hash:string;response:DispatchSlotView}}>('SELECT payload FROM queue_dispatch_events WHERE operation_key=$1',[operationKey])).rows[0]
      if(old) {
        if(old.payload.input_hash!==inputHash) throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT')
        return old.payload.response
      }
      const runtimes = new Set(ps.map(p => p.config.runtime)); if (runtimes.size !== 1) return forbidden()
      let productIds = [...new Set(ps.flatMap(p => p.config.product_ids))].filter(id => !target.scopedProducts.length || target.scopedProducts.includes(id))
      for (const id of productIds) await deps.auth.authorizeDispatch(target, productInput(id), 'claim', db)
      let config: ManagedSlotConfig = {
        version: 1, runtime: ps[0].config.runtime, product_ids: productIds,
        capabilities: [...new Set(ps.flatMap(p => [...(p.config.actions.includes('review') ? ['review'] : []), ...(p.config.access === 'repo_write' ? ['code_edit'] : [])]))], tier: null, worker_instance_id: null
      }
      if (input.kind === 'job') {
        const instanceId = capacityKey.slice(4)
        const workers = (await db.query<{ runtime: 'CODEX' | 'CLAUDE'; capabilities: string[]; capability: ManagedSlotConfig['tier']; product_id: string | null }>(
          'SELECT runtime,capabilities,capability,product_id FROM claude_workers WHERE user_id=$1 AND token_id=$2 AND instance_id=$3 AND last_seen_at>now()-interval \'30 seconds\'', [target.userId, target.tokenId, instanceId])).rows
        if (workers.length !== 1 || workers[0].runtime !== config.runtime) return forbidden()
        const w = workers[0]; productIds = productIds.filter(id => !w.product_id || w.product_id === id)
        config = { ...config, product_ids: productIds, capabilities: w.capabilities, tier: w.capability, worker_instance_id: instanceId }
      }
      if (!productIds.includes(input.product_id)) return forbidden()
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [capacityKey])
      const existing = (await db.query<{ id: string; owner_user_id: string; config: ManagedSlotConfig; enabled: boolean }>('SELECT id,owner_user_id,config,enabled FROM queue_dispatch_slots WHERE capacity_key=$1 FOR UPDATE', [capacityKey])).rows[0]
      if (existing && existing.owner_user_id !== target.userId) return conflict()
      // Capacity identity survives token/profile changes and disabled state. Open
      // incarnations retain their own original token/config as evidence.
      const id = existing?.id ?? randomUUID()
      if (existing) await db.query('UPDATE queue_dispatch_slots SET token_id=$2,config=$3::jsonb WHERE id=$1', [id, target.tokenId, JSON.stringify(config)])
      else await db.query(`INSERT INTO queue_dispatch_slots(id,capacity_key,owner_user_id,token_id,kind,address,config,enabled) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,true)`, [id, capacityKey, target.userId, target.tokenId, input.kind, address, JSON.stringify(config)])
      for (const p of ps) await db.query('INSERT INTO queue_dispatch_slot_profiles(slot_id,profile_revision_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, p.id])
      const response:DispatchSlotView = { id, version: '1', enabled: existing?.enabled ?? true, kind: input.kind, address, profile_revision_ids: (await db.query<{ profile_revision_id: string }>('SELECT profile_revision_id FROM queue_dispatch_slot_profiles WHERE slot_id=$1 ORDER BY profile_revision_id', [id])).rows.map(p => p.profile_revision_id) }
      await db.query(`INSERT INTO queue_dispatch_events(id,type,actor,payload,action_id,operation_key) VALUES($1,'slot',$2::jsonb,$3::jsonb,$4,$5)`,
        [randomUUID(),JSON.stringify({user_id:actor.userId,token_id:actor.tokenId}),JSON.stringify({input_hash:inputHash,response}),input.action_id,operationKey])
      return response
    })
  }
  return { registerDispatchExecutor, heartbeatExecutor, createSlot }
}
