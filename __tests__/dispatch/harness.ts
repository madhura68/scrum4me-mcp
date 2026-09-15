import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { DispatchInput, DispatchProfileConfig } from '@shared/queue-dispatch.js'
import { parseDispatchInput } from '@shared/queue-dispatch-validation.js'
import type { DispatchActor } from '../../src/dispatch/ports.js'
import { assertDispatchTestUrl, assertTestCluster } from '../../scripts/dispatch-test-db.mjs'

type FixtureIds = {
  userId: string
  otherUserId: string
  productId: string
  tokenId: string
  profileId: string
  slotIds: string[]
}

export type DispatchHarnessSeed = {
  actor: DispatchActor
  input: DispatchInput
  jobSlot: { id: string; incarnationId: string }
  hostSlot: { id: string; incarnationId: string }
  otherUser: string
  profileId: string
}

export interface DispatchHarness {
  admin: Pool
  dispatch: Pool
  queue: Pool
  web: Pool
  seed(input?: Partial<DispatchInput>): Promise<DispatchHarnessSeed>
  reset(): Promise<void>
  close(): Promise<void>
  barrier(count: number): () => Promise<void>
}

function makeBarrier(count: number): () => Promise<void> {
  if (!Number.isInteger(count) || count < 1) throw new Error('DISPATCH_BARRIER_COUNT_INVALID')
  let arrivals = 0
  let release: (() => void) | undefined
  const allArrived = new Promise<void>((resolve) => { release = resolve })
  return async () => {
    arrivals += 1
    if (arrivals === count) release?.()
    await allArrived
  }
}

export async function makeDispatchHarness(): Promise<DispatchHarness> {
  const definitions = [
    ['admin', 'DISPATCH_TEST_ADMIN_URL'],
    ['dispatch', 'DISPATCH_TEST_URL'],
    ['queue', 'DISPATCH_TEST_QUEUE_URL'],
    ['web', 'DISPATCH_TEST_WEB_URL'],
  ] as const
  const urls = definitions.map(([name, key]) => [
    name,
    assertDispatchTestUrl(process.env[key]),
  ] as const)
  if (new Set(urls.map(([, url]) => `${url.hostname}:${url.port}`)).size !== 1) {
    throw new Error('DISPATCH_TEST_TARGET_REFUSED')
  }
  const pools = Object.fromEntries(urls.map(([name, url]) => [
    name,
    new Pool({ connectionString: url.href, max: 2, application_name: `mcp-dispatch-test:${name}` }),
  ])) as Record<(typeof definitions)[number][0], Pool>
  try {
    for (const pool of Object.values(pools)) await assertTestCluster(pool)
  } catch (error) {
    await Promise.allSettled(Object.values(pools).map((pool) => pool.end()))
    throw error
  }

  const fixtures: FixtureIds[] = []

  const reset = async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.at(-1) as FixtureIds
      const client = await pools.admin.connect()
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL session_replication_role='replica'")
        const requestIds = (await client.query<{ id: string }>(
          'SELECT id FROM queue_dispatch_requests WHERE product_id=$1',
          [fixture.productId],
        )).rows.map(({ id }) => id)
        if (requestIds.length > 0) {
          for (const table of [
            'queue_dispatch_publications', 'queue_dispatch_artifacts', 'queue_dispatch_results',
            'queue_dispatch_events', 'queue_dispatch_outbox',
          ]) {
            await client.query(`DELETE FROM ${table} WHERE request_id=ANY($1::uuid[])`, [requestIds])
          }
          await client.query(
            `DELETE FROM queue_dispatch_attempts WHERE candidate_id IN
             (SELECT id FROM queue_dispatch_candidates WHERE request_id=ANY($1::uuid[]))`,
            [requestIds],
          )
          await client.query(
            `DELETE FROM queue_dispatch_reservations WHERE candidate_id IN
             (SELECT id FROM queue_dispatch_candidates WHERE request_id=ANY($1::uuid[]))`,
            [requestIds],
          )
          await client.query('DELETE FROM claude_jobs WHERE dispatch_request_id=ANY($1::uuid[])', [requestIds])
          await client.query('DELETE FROM queue_dispatch_candidates WHERE request_id=ANY($1::uuid[])', [requestIds])
          await client.query('DELETE FROM queue_dispatch_requests WHERE id=ANY($1::uuid[])', [requestIds])
        }
        await client.query(
          'DELETE FROM queue_dispatch_slot_profiles WHERE slot_id=ANY($1::uuid[])',
          [fixture.slotIds],
        )
        await client.query(
          'DELETE FROM queue_dispatch_incarnations WHERE slot_id=ANY($1::uuid[])',
          [fixture.slotIds],
        )
        await client.query('DELETE FROM queue_dispatch_slots WHERE id=ANY($1::uuid[])', [fixture.slotIds])
        await client.query('DELETE FROM queue_dispatch_profiles WHERE id=$1', [fixture.profileId])
        await client.query(
          'DELETE FROM queue_dispatch_reply_addresses WHERE user_id=ANY($1::text[])',
          [[fixture.userId, fixture.otherUserId]],
        )
        await client.query('DELETE FROM api_tokens WHERE id=$1', [fixture.tokenId])
        await client.query('DELETE FROM products WHERE id=$1', [fixture.productId])
        await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [
          [fixture.userId, fixture.otherUserId],
        ])
        await client.query('COMMIT')
        fixtures.pop()
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
  }

  const seed = async (overrides: Partial<DispatchInput> = {}): Promise<DispatchHarnessSeed> => {
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const productId = randomUUID()
    const tokenId = randomUUID()
    const profileId = randomUUID()
    const jobSlotId = randomUUID()
    const hostSlotId = randomUUID()
    const jobIncarnationId = randomUUID()
    const hostIncarnationId = randomUUID()
    const profile: DispatchProfileConfig = {
      version: 1,
      runtime: 'CODEX',
      actions: ['free_task'],
      product_ids: [productId],
      repository_product_ids: [],
      environment_keys: [],
      access: 'read',
      publish_modes: ['artifact'],
      image_digest: `sha256:${'a'.repeat(64)}`,
      source_mount_keys: [],
      provider_egress_hosts: [],
      cpu_millis: 1000,
      memory_mb: 1024,
      pids_limit: 128,
      max_duration_seconds: 300,
      protocol: 'dispatch-v1',
    }
    const defaultInput: DispatchInput = {
      version: 1,
      product_id: productId,
      action: 'free_task',
      objective: 'Onderzoek de vastgezette bron zonder wijzigingen',
      verification: 'Lever controleerbaar Markdown-bewijs',
      response_format: 'Markdown',
      requirements: { access: 'read', environment_keys: [] },
      publish: 'artifact',
      reply_to: 'mac:jp',
    }
    const input = parseDispatchInput({
      ...defaultInput,
      ...overrides,
      product_id: productId,
    })
    const actor: DispatchActor = {
      userId,
      principalKey: `bearer:${userId}:${tokenId}`,
      tokenId,
      source: 'bearer',
      isDemo: false,
      scopedProducts: [productId],
      scopedRepos: [],
      tokenKind: 'IMPLEMENTATION',
    }

    fixtures.push({
      userId,
      otherUserId,
      productId,
      tokenId,
      profileId,
      slotIds: [jobSlotId, hostSlotId],
    })

    await pools.admin.query(
      `INSERT INTO users(id,email,username,password_hash,updated_at)
       VALUES($1,$2,$1,'test',now()),($3,$4,$3,'test',now())`,
      [userId, `${userId}@example.test`, otherUserId, `${otherUserId}@example.test`],
    )
    await pools.admin.query(
      `INSERT INTO products(id,name,user_id,definition_of_done,updated_at)
       VALUES($1,$2,$3,'test',now())`,
      [productId, `dispatch-fixture-${productId}`, userId],
    )
    await pools.admin.query(
      `INSERT INTO api_tokens(id,user_id,token_hash,kind,scoped_products)
       VALUES($1,$2,$3,'IMPLEMENTATION',$4::text[])`,
      [tokenId, userId, randomUUID(), [productId]],
    )
    await pools.dispatch.query(
      `INSERT INTO queue_dispatch_profiles
       (id,key,revision,product_id,owner_user_id,config,sha256)
       VALUES($1,$2,1,$3,$4,$5,$6)`,
      [profileId, `fixture-${profileId}`, productId, userId, JSON.stringify(profile), 'a'.repeat(64)],
    )
    await pools.dispatch.query(
      `INSERT INTO queue_dispatch_slots
       (id,capacity_key,owner_user_id,token_id,kind,address,config,enabled)
       VALUES($1,$2,$3,$4,'job',NULL,'{}',true),
             ($5,$6,$3,$4,'host',$7,'{}',true)`,
      [jobSlotId, `job:${jobSlotId}`, userId, tokenId,
        hostSlotId, 'host:max2:codex', 'max2:codex'],
    )
    await pools.dispatch.query(
      `INSERT INTO queue_dispatch_slot_profiles(slot_id,profile_revision_id)
       VALUES($1,$3),($2,$3)`,
      [jobSlotId, hostSlotId, profileId],
    )
    await pools.dispatch.query(
      `INSERT INTO queue_dispatch_incarnations
       (id,slot_id,boot_id,credential_hash,credential_key_version,last_seen_at,runtime_scope)
       VALUES($1,$2,$3,$4,1,now(),'{}'),($5,$6,$7,$8,1,now(),'{}')`,
      [jobIncarnationId, jobSlotId, `boot-${jobIncarnationId}`, 'b'.repeat(64),
        hostIncarnationId, hostSlotId, `boot-${hostIncarnationId}`, 'c'.repeat(64)],
    )
    await pools.dispatch.query(
      `INSERT INTO queue_dispatch_reply_addresses(user_id,address,enabled)
       VALUES($1,'mac:jp',true)`,
      [userId],
    )

    return {
      actor,
      input,
      jobSlot: { id: jobSlotId, incarnationId: jobIncarnationId },
      hostSlot: { id: hostSlotId, incarnationId: hostIncarnationId },
      otherUser: otherUserId,
      profileId,
    }
  }

  return {
    ...pools,
    seed,
    reset,
    close: async () => {
      try {
        await reset()
      } finally {
        await Promise.allSettled(Object.values(pools).map((pool) => pool.end()))
      }
    },
    barrier: makeBarrier,
  }
}
