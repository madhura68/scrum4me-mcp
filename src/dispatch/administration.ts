import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { formatQueueAddress, parseQueueAddress } from '@shared/queue-identity.js'
import { dispatchProfileConfigSchema } from '@shared/queue-dispatch-validation.js'
import type { DispatchProfileConfig } from '@shared/queue-dispatch.js'
import type { DispatchActor } from './ports.js'
import type { DispatchAuth } from './auth.js'
import { withDispatchRetryTransaction, type DispatchStore } from './db.js'
import { withDispatchOperation } from './requests.js'
import { artifactHash } from './artifacts.js'
import { canonicalResult } from './lifecycle.js'
import { productInput } from './registration.js'
import { DispatchError } from './errors.js'

/** Profile revision as both existing clients read it. `id` is the MCP/CLI name
 * (`DispatchProfileView`), `revision_id` the workers name (`DispatchProfileRevision`);
 * they always carry the same value, so neither consumer has to be changed. */
export type DispatchProfileRecord = {
  id: string; revision_id: string; key: string; revision: number
  product_id: string; config: DispatchProfileConfig; sha256: string; revoked_at: string | null
}
/** Slot status as both existing clients read it: the MCP `DispatchSlotView` fields plus the
 * four separate facts the workers `DispatchSlotStatus` distinguishes. Presence (`liveness`)
 * is deliberately not folded into readiness, isolation or occupancy. */
export type DispatchSlotRecord = {
  id: string; version: string; capacity_key: string; kind: 'job' | 'host'; address: string | null
  enabled: boolean; protocol_ready: boolean; isolation_verified: boolean
  liveness: 'live' | 'stale' | 'unregistered'; occupied: boolean; profile_revision_ids: string[]
}
export type DispatchProfilesView = { profiles: DispatchProfileRecord[]; slots: DispatchSlotRecord[] }

const invalid = (): never => { throw new DispatchError('DISPATCH_INVALID_INPUT') }
const forbidden = (): never => { throw new DispatchError('DISPATCH_FORBIDDEN') }
const conflict = (): never => { throw new DispatchError('DISPATCH_STATE_CONFLICT') }
const keyValid = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const keys = (value: object) => Object.keys(value).sort().join(',')
/** A slot carries no version column; `enabled` is its only mutable fact, so the
 * optimistic token is derived from it. An enabled slot reads '1', a disabled one '2'. */
const slotVersion = (enabled: boolean) => enabled ? '1' : '2'

type ProfileRow = { id: string; key: string; revision: number; product_id: string; config: DispatchProfileConfig; sha256: string; revoked_at: Date | null }
const profileRecord = (row: ProfileRow): DispatchProfileRecord => ({
  id: row.id, revision_id: row.id, key: row.key, revision: row.revision, product_id: row.product_id,
  config: row.config, sha256: row.sha256, revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
})

export type ProfileCreateInput = { action_id: string; key: string; product_id: string; config: DispatchProfileConfig }
export type ProfileRevokeInput = { action_id: string; reason: string }
export type SlotDisableInput = { action_id: string; expected_version: string }
export type ReplyAddressInput = { action_id: string; user_id: string; address: string }
export type OutboxRepublishInput = { action_id: string; published_after: string }
export type OutboxRepublishReceipt = { published_after: string; requests: number; request_ids: string[] }
/** One call is bounded; a larger restore is several calls, each with its own action id and receipt. */
export const OUTBOX_REPUBLISH_LIMIT = 500

export function createDispatchAdministration(deps: { store: DispatchStore; auth: DispatchAuth }) {
  /** Product-administrator authority over every product the revision can reach, never just the
   * product named in the request: a profile's own product list is what execution will honour. */
  async function authorizeProfileScope(db: PoolClient, actor: DispatchActor, productId: string, config?: DispatchProfileConfig) {
    const products = new Set([productId, ...(config?.product_ids ?? []), ...(config?.repository_product_ids ?? [])])
    for (const id of [...products].sort()) await deps.auth.authorizeDispatch(actor, productInput(id), 'profile', db)
  }
  async function loadProfile(db: PoolClient, id: string): Promise<ProfileRow> {
    const row = (await db.query<ProfileRow>('SELECT id,key,revision,product_id,config,sha256,revoked_at FROM queue_dispatch_profiles WHERE id=$1 FOR UPDATE', [id])).rows[0]
    if (!row) throw new DispatchError('DISPATCH_NOT_FOUND')
    return row
  }
  async function createProfile(actor: DispatchActor, input: ProfileCreateInput): Promise<DispatchProfileRecord> {
    if (!input || typeof input !== 'object' || keys(input) !== 'action_id,config,key,product_id'
      || !keyValid(input.action_id) || !keyValid(input.key) || typeof input.product_id !== 'string' || !input.product_id) invalid()
    const parsed = dispatchProfileConfigSchema.safeParse(input.config)
    if (!parsed.success) invalid()
    const config = parsed.data as DispatchProfileConfig
    if (!config.product_ids.includes(input.product_id)) invalid()
    const sha256 = artifactHash(canonicalResult(config))
    const payloadHash = artifactHash(canonicalResult({ key: input.key, product_id: input.product_id, config }))
    const receipt = await withDispatchOperation(deps.store, { actor, operation: 'profile', actionId: input.action_id, payloadHash }, async db => {
      await authorizeProfileScope(db, actor, input.product_id, config)
      // One advisory lock per key makes the revision counter a real sequence under concurrency.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dispatch-profile-key:${input.key}`])
      const siblings = (await db.query<{ revision: number; product_id: string; owner_user_id: string }>(
        'SELECT revision,product_id,owner_user_id FROM queue_dispatch_profiles WHERE key=$1 ORDER BY revision DESC', [input.key])).rows
      // A key is owned: a later revision can never move it to another product or owner.
      if (siblings.some(s => s.product_id !== input.product_id || s.owner_user_id !== actor.userId)) conflict()
      const id = randomUUID(), revision = (siblings[0]?.revision ?? 0) + 1
      const row = (await db.query<ProfileRow>(
        `INSERT INTO queue_dispatch_profiles(id,key,revision,product_id,owner_user_id,config,sha256)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id,key,revision,product_id,config,sha256,revoked_at`,
        [id, input.key, revision, input.product_id, actor.userId, JSON.stringify(config), sha256])).rows[0]
      return profileRecord(row) as unknown as import('./requests.js').DispatchReceipt
    })
    return receipt as unknown as DispatchProfileRecord
  }
  async function revokeProfile(actor: DispatchActor, id: string, input: ProfileRevokeInput): Promise<DispatchProfileRecord> {
    if (!input || typeof input !== 'object' || keys(input) !== 'action_id,reason' || !keyValid(input.action_id)
      || typeof input.reason !== 'string' || !input.reason || input.reason.length > 4000) invalid()
    const payloadHash = artifactHash(canonicalResult({ id, reason: input.reason }))
    const receipt = await withDispatchOperation(deps.store, { actor, operation: 'revoke_profile', actionId: input.action_id, payloadHash }, async db => {
      const row = await loadProfile(db, id)
      await authorizeProfileScope(db, actor, row.product_id, row.config)
      // Revocation is a one-way marker: an existing revocation timestamp is never overwritten,
      // and the immutable config/hash of the revision stays exactly as it was.
      const updated = (await db.query<ProfileRow>(
        'UPDATE queue_dispatch_profiles SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id,key,revision,product_id,config,sha256,revoked_at', [id])).rows[0]
      return { ...profileRecord(updated), reason: input.reason } as unknown as import('./requests.js').DispatchReceipt
    })
    return receipt as unknown as DispatchProfileRecord
  }
  async function listProfiles(actor: DispatchActor, productId: string): Promise<DispatchProfilesView> {
    if (typeof productId !== 'string' || !productId) invalid()
    return withDispatchRetryTransaction(deps.store, async db => {
      await deps.auth.authorizeDispatch(actor, productInput(productId), 'profile', db)
      const profiles = (await db.query<ProfileRow>(
        `SELECT id,key,revision,product_id,config,sha256,revoked_at FROM queue_dispatch_profiles
         WHERE product_id=$1 OR config->'product_ids' ? $1 ORDER BY key,revision`, [productId])).rows.map(profileRecord)
      if (!profiles.length) return { profiles, slots: [] }
      const slots = (await db.query<{
        id: string; capacity_key: string; kind: 'job' | 'host'; address: string | null; enabled: boolean
        profile_revision_ids: string[]; occupied: boolean; incarnation_scope: Record<string, unknown> | null
        fresh: boolean | null; registered: boolean
      }>(`SELECT s.id,s.capacity_key,s.kind,s.address,s.enabled,
        ARRAY(SELECT profile_revision_id::text FROM queue_dispatch_slot_profiles WHERE slot_id=s.id ORDER BY profile_revision_id) AS profile_revision_ids,
        EXISTS(SELECT 1 FROM queue_dispatch_reservations WHERE slot_id=s.id AND released_at IS NULL) AS occupied,
        i.runtime_scope AS incarnation_scope, i.id IS NOT NULL AS registered,
        i.last_seen_at>now()-make_interval(secs=>CASE WHEN s.kind='job' THEN 30 ELSE 45 END) AS fresh
        FROM queue_dispatch_slots s
        LEFT JOIN queue_dispatch_incarnations i ON i.slot_id=s.id AND i.signed_off_at IS NULL
        WHERE EXISTS(SELECT 1 FROM queue_dispatch_slot_profiles b WHERE b.slot_id=s.id AND b.profile_revision_id=ANY($1::uuid[]))
        ORDER BY s.id`, [profiles.map(p => p.id)])).rows
      return {
        profiles,
        slots: slots.map(row => {
          const scope = row.incarnation_scope as { profile_revision_ids?: string[]; image_digest?: string; profile_sha256?: string } | null
          const bound = profiles.filter(p => !p.revoked_at && row.profile_revision_ids.includes(p.id))
          const registered = bound.filter(p => scope?.profile_revision_ids?.includes(p.id))
          return {
            id: row.id, version: slotVersion(row.enabled), capacity_key: row.capacity_key, kind: row.kind,
            address: row.address, enabled: row.enabled,
            protocol_ready: registered.some(p => p.config.protocol === 'dispatch-v1'),
            isolation_verified: registered.some(p => p.sha256 === scope?.profile_sha256 && p.config.image_digest === scope?.image_digest),
            liveness: !row.registered ? 'unregistered' as const : row.fresh ? 'live' as const : 'stale' as const,
            occupied: row.occupied, profile_revision_ids: row.profile_revision_ids,
          }
        }),
      }
    })
  }
  async function disableSlot(actor: DispatchActor, id: string, input: SlotDisableInput): Promise<DispatchSlotRecord> {
    if (!input || typeof input !== 'object' || keys(input) !== 'action_id,expected_version' || !keyValid(input.action_id)
      || typeof input.expected_version !== 'string' || !/^[1-9][0-9]*$/.test(input.expected_version)) invalid()
    const payloadHash = artifactHash(canonicalResult({ id, expected_version: input.expected_version }))
    const receipt = await withDispatchOperation(deps.store, { actor, operation: 'disable_slot', actionId: input.action_id, payloadHash }, async db => {
      const slot = (await db.query<{ id: string; capacity_key: string; kind: 'job' | 'host'; address: string | null; enabled: boolean; owner_user_id: string; config: { product_ids?: string[] } }>(
        'SELECT id,capacity_key,kind,address,enabled,owner_user_id,config FROM queue_dispatch_slots WHERE id=$1 FOR UPDATE', [id])).rows[0]
      if (!slot) throw new DispatchError('DISPATCH_NOT_FOUND')
      for (const productId of [...new Set(slot.config.product_ids ?? [])].sort()) {
        await deps.auth.authorizeDispatch(actor, productInput(productId), 'profile', db)
      }
      if (!slot.config.product_ids?.length) forbidden()
      if (slotVersion(slot.enabled) !== input.expected_version) conflict()
      // No new claims. Open reservations and running attempts are deliberately left alone;
      // capacity is released by stop evidence, never by an administrative flag.
      await db.query('UPDATE queue_dispatch_slots SET enabled=false WHERE id=$1', [id])
      const profileRevisionIds = (await db.query<{ profile_revision_id: string }>(
        'SELECT profile_revision_id FROM queue_dispatch_slot_profiles WHERE slot_id=$1 ORDER BY profile_revision_id', [id])).rows.map(r => r.profile_revision_id)
      const occupied = !!(await db.query('SELECT 1 FROM queue_dispatch_reservations WHERE slot_id=$1 AND released_at IS NULL', [id])).rowCount
      const record: DispatchSlotRecord = {
        id, version: slotVersion(false), capacity_key: slot.capacity_key, kind: slot.kind, address: slot.address,
        enabled: false, protocol_ready: false, isolation_verified: false, liveness: 'unregistered', occupied, profile_revision_ids: profileRevisionIds,
      }
      return record as unknown as import('./requests.js').DispatchReceipt
    })
    return receipt as unknown as DispatchSlotRecord
  }
  async function allowReplyAddress(actor: DispatchActor, input: ReplyAddressInput): Promise<{ user_id: string; address: string; enabled: boolean }> {
    if (!input || typeof input !== 'object' || keys(input) !== 'action_id,address,user_id' || !keyValid(input.action_id)
      || typeof input.user_id !== 'string' || !input.user_id || typeof input.address !== 'string') invalid()
    let address: string
    try { address = formatQueueAddress(parseQueueAddress(input.address.trim().toLowerCase())) } catch { return invalid() }
    const payloadHash = artifactHash(canonicalResult({ user_id: input.user_id, address }))
    const receipt = await withDispatchOperation(deps.store, { actor, operation: 'reply_address', actionId: input.action_id, payloadHash }, async db => {
      const current = await deps.auth.refreshActor(actor, db)
      // The browser issuer may read and cancel only; a reply-address binding is a managed write.
      if (current.source === 'web') forbidden()
      const row = (await db.query<{ admin: boolean; administers: boolean; target: boolean; demo: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role='ADMIN') AS admin,
         EXISTS(SELECT 1 FROM products p WHERE p.user_id=$1 AND (p.user_id=$2
           OR EXISTS(SELECT 1 FROM product_members m WHERE m.product_id=p.id AND m.user_id=$2))) AS administers,
         EXISTS(SELECT 1 FROM users WHERE id=$2) AS target,
         COALESCE((SELECT is_demo FROM users WHERE id=$2),true) AS demo`, [current.userId, input.user_id])).rows[0]
      if (!row.target || row.demo || !(row.admin || row.administers)) forbidden()
      await db.query(`INSERT INTO queue_dispatch_reply_addresses(user_id,address,enabled) VALUES($1,$2,true)
        ON CONFLICT(user_id,address) DO UPDATE SET enabled=true`, [input.user_id, address])
      return { user_id: input.user_id, address, enabled: true }
    })
    return receipt as unknown as { user_id: string; address: string; enabled: boolean }
  }
  /** Queue restore. A queue database restored to an earlier point has lost deliveries the outbox
   * already marked published, so the newest snapshot of each affected request is handed back to
   * the projector. It clears a publication marker and nothing else: no execution state, no result,
   * no older snapshot — the newest one already contains them. The projection itself stays monotone
   * and version-guarded, so a redelivery can never rewrite an answer a reader already handled.
   * `published_after` is the restore point; the receipt is the action's durable answer. */
  async function republishOutbox(actor: DispatchActor, input: OutboxRepublishInput): Promise<OutboxRepublishReceipt> {
    if (!input || typeof input !== 'object' || keys(input) !== 'action_id,published_after' || !keyValid(input.action_id)
      || typeof input.published_after !== 'string' || Number.isNaN(Date.parse(input.published_after))) invalid()
    const publishedAfter = new Date(input.published_after).toISOString()
    const payloadHash = artifactHash(canonicalResult({ published_after: publishedAfter }))
    const receipt = await withDispatchOperation(deps.store, { actor, operation: 'republish_outbox', actionId: input.action_id, payloadHash }, async db => {
      const current = await deps.auth.refreshActor(actor, db)
      // Redelivery crosses every product, so it takes the one authority that does too. The browser
      // issuer may read and cancel; it never republishes.
      if (current.source === 'web') forbidden()
      if (!(await db.query("SELECT 1 FROM user_roles WHERE user_id=$1 AND role='ADMIN'", [current.userId])).rowCount) forbidden()
      const rows = (await db.query<{ request_id: string }>(
        `WITH newest AS (SELECT DISTINCT ON (request_id) id,published_at FROM queue_dispatch_outbox ORDER BY request_id,version DESC)
         UPDATE queue_dispatch_outbox o SET published_at=NULL,attempts=0,next_attempt_at=now()
         FROM (SELECT id FROM newest WHERE published_at>=$1::timestamptz ORDER BY id LIMIT ${OUTBOX_REPUBLISH_LIMIT}) target
         WHERE o.id=target.id RETURNING o.request_id`, [publishedAfter])).rows
      return { published_after: publishedAfter, requests: rows.length, request_ids: [...rows.map(row => row.request_id)].sort() }
    })
    return receipt as unknown as OutboxRepublishReceipt
  }
  return { createProfile, revokeProfile, listProfiles, disableSlot, allowReplyAddress, republishOutbox }
}
export type DispatchAdministration = ReturnType<typeof createDispatchAdministration>
