import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DispatchInput } from '@shared/queue-dispatch.js'
import {
  DISPATCH_SCHEMA_COMMIT,
  assertDispatchSchemaRoot,
  assertDispatchTestUrl,
  assertTestCluster,
  checkDispatchTestTarget,
  provisionDispatchTestTarget,
} from '../../scripts/dispatch-test-db.mjs'
import { createDispatchStore, withDispatchTransaction } from '../../src/dispatch/db.js'
import { DispatchError } from '../../src/dispatch/errors.js'
import type { PublisherPort, RuntimePort } from '../../src/dispatch/ports.js'
import { makeDispatchHarness, type DispatchHarness } from './harness.js'

type DispatchSideEffectPorts = RuntimePort | PublisherPort
const _typecheckSideEffectPorts = (port: DispatchSideEffectPorts): DispatchSideEffectPorts => port
void _typecheckSideEffectPorts

const repository = new URL('../..', import.meta.url)
const schemaRoot = process.env.DISPATCH_TEST_SCHEMA_ROOT ?? ''
const dirtySchemaSourceCases: Array<{
  name: string
  mutate(root: string): void
}> = [
  {
    name: 'unstaged tracked',
    mutate: (root) => appendFileSync(
      join(root, 'scripts/queue-dispatch/provision.ts'),
      '\n// dirty unstaged\n',
    ),
  },
  {
    name: 'staged tracked',
    mutate: (root) => {
      appendFileSync(join(root, 'scripts/queue-dispatch/provision.ts'), '\n// dirty staged\n')
      execFileSync('git', ['add', 'scripts/queue-dispatch/provision.ts'], { cwd: root })
    },
  },
  {
    name: 'module-relevant untracked',
    mutate: (root) => writeFileSync(
      join(root, 'scripts/queue-dispatch/contract-inventory.js'),
      'throw new Error("UNREVIEWED_MODULE")\n',
    ),
  },
]

let harness: DispatchHarness

beforeAll(async () => {
  harness = await makeDispatchHarness()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await harness.reset()
})

afterAll(async () => {
  await harness?.close()
})

describe('dispatch test target', () => {
  it('fails closed when the dedicated URLs are missing', () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('DISPATCH_TEST_')),
    ) as NodeJS.ProcessEnv
    env.DISPATCH_TEST_SCHEMA_ROOT = schemaRoot

    const result = spawnSync(process.execPath, ['scripts/dispatch-test-db.mjs', 'check'], {
      cwd: repository,
      env,
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DISPATCH_TEST_URL_REQUIRED')
  })

  it.each([
    'postgresql://localhost/scrum4me',
    'postgresql://example.com/s4m_dispatch_test',
    'https://localhost/s4m_dispatch_test',
    'postgresql://localhost/s4m_dispatch_test?sslmode=disable',
    'postgresql://localhost/s4m_dispatch_test#fragment',
  ])('refuses unsafe target %s', (url) => {
    expect(() => assertDispatchTestUrl(url, { CI: 'false' })).toThrow(
      'DISPATCH_TEST_TARGET_REFUSED',
    )
  })

  it('keeps the MCP adapter refusal cases equal to the pinned main guard', async () => {
    const mainGuard = await import(pathToFileURL(
      `${schemaRoot}/scripts/queue-dispatch/test-db.mjs`,
    ).href) as {
      assertDispatchTestUrl(raw: string): URL
      assertTestCluster(client: { query: (sql: string) => Promise<{
        rows: { production: boolean }[]
      }> }): Promise<void>
    }
    const refused = [
      'postgresql://localhost/scrum4me',
      'postgresql://example.com/s4m_dispatch_test',
      'https://localhost/s4m_dispatch_test',
      'postgresql://localhost/s4m_dispatch_test?sslmode=disable',
      'postgresql://localhost/s4m_dispatch_test#fragment',
    ]
    for (const url of refused) {
      expect(() => assertDispatchTestUrl(url, { CI: 'false' })).toThrow(
        'DISPATCH_TEST_TARGET_REFUSED',
      )
      expect(() => mainGuard.assertDispatchTestUrl(url)).toThrow(
        'DISPATCH_TEST_TARGET_REFUSED',
      )
    }
    const production = { query: async () => ({ rows: [{ production: true }] }) }
    await expect(assertTestCluster(production)).rejects.toThrow(
      'DISPATCH_PRODUCTION_CLUSTER_REFUSED',
    )
    await expect(mainGuard.assertTestCluster(production)).rejects.toThrow(
      'DISPATCH_PRODUCTION_CLUSTER_REFUSED',
    )
  })

  it('accepts the CI service host only in CI', () => {
    expect(assertDispatchTestUrl(
      'postgresql://postgres:5432/s4m_dispatch_test',
      { CI: 'true' },
    ).hostname).toBe('postgres')
    expect(() => assertDispatchTestUrl(
      'postgresql://localhost/s4m_dispatch_test',
      { CI: 'true' },
    )).toThrow('DISPATCH_TEST_TARGET_REFUSED')
  })

  it('validates every URL and shared target before opening the first connection', async () => {
    await expect(checkDispatchTestTarget({
      ...process.env,
      DISPATCH_TEST_SCHEMA_ROOT: schemaRoot,
      DISPATCH_TEST_ADMIN_URL: 'postgresql://unused@localhost:1/s4m_dispatch_test',
      DISPATCH_TEST_URL: 'postgresql://unused@localhost:2/s4m_dispatch_test',
      DISPATCH_TEST_QUEUE_URL: 'postgresql://unused@localhost:1/s4m_dispatch_test',
      DISPATCH_TEST_WEB_URL: 'postgresql://unused@localhost:1/s4m_dispatch_test',
    })).rejects.toThrow('DISPATCH_TEST_TARGET_REFUSED')
  })

  it('refuses a cluster that contains the production database sentinel', async () => {
    await expect(assertTestCluster({
      query: async () => ({ rows: [{ production: true }] }),
    })).rejects.toThrow('DISPATCH_PRODUCTION_CLUSTER_REFUSED')
  })

  it('pins provisioning to the reviewed main migration commit', () => {
    expect(assertDispatchSchemaRoot(schemaRoot)).toBe(schemaRoot)
    expect(() => assertDispatchSchemaRoot(repository.pathname)).toThrow(
      'DISPATCH_TEST_SCHEMA_ROOT_REFUSED',
    )
  })

  it.each(dirtySchemaSourceCases)(
    'refuses a $name schema source before provisioning',
    async ({ mutate }) => {
      const fixtureParent = mkdtempSync(join(tmpdir(), 'mcp-dispatch-schema-source-'))
      const fixtureRoot = join(fixtureParent, 'main')
      try {
        execFileSync('git', ['clone', '--quiet', '--no-checkout', schemaRoot, fixtureRoot])
        execFileSync('git', ['checkout', '--quiet', '--detach', DISPATCH_SCHEMA_COMMIT], {
          cwd: fixtureRoot,
        })
        mutate(fixtureRoot)

        await expect(provisionDispatchTestTarget({
          DISPATCH_TEST_SCHEMA_ROOT: fixtureRoot,
        })).rejects.toThrow('DISPATCH_TEST_SCHEMA_ROOT_REFUSED')
      } finally {
        rmSync(fixtureParent, { recursive: true, force: true })
      }
    },
  )

  it('routes dispatch integration files only through the serial dispatch config', () => {
    const vitest = 'node_modules/vitest/vitest.mjs'
    const ordinary = spawnSync(process.execPath, [vitest, 'list', '--config', 'vitest.config.ts'], {
      cwd: repository,
      encoding: 'utf8',
    })
    const dispatch = spawnSync(process.execPath, [vitest, 'list', '--config', 'vitest.dispatch.config.ts'], {
      cwd: repository,
      encoding: 'utf8',
    })

    expect(ordinary.status).toBe(0)
    expect(ordinary.stdout).not.toContain('__tests__/dispatch/schema.integration.test.ts')
    expect(dispatch.status).toBe(0)
    expect(dispatch.stdout).toContain('__tests__/dispatch/schema.integration.test.ts')
  })
})

describe('dispatch service ports and real PostgreSQL roles', () => {
  it('contains the complete durable dispatch schema and all three pinned migrations', async () => {
    const tables = (await harness.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE 'queue_dispatch_%'
       ORDER BY table_name`,
    )).rows.map(({ table_name }) => table_name)
    expect(tables).toEqual([
      'queue_dispatch_artifacts',
      'queue_dispatch_attempts',
      'queue_dispatch_candidates',
      'queue_dispatch_events',
      'queue_dispatch_incarnations',
      'queue_dispatch_outbox',
      'queue_dispatch_profiles',
      'queue_dispatch_publications',
      'queue_dispatch_reply_addresses',
      'queue_dispatch_requests',
      'queue_dispatch_reservations',
      'queue_dispatch_results',
      'queue_dispatch_slot_profiles',
      'queue_dispatch_slots',
    ])

    const migrations = (await harness.admin.query<{ migration_name: string }>(
      `SELECT migration_name FROM _prisma_migrations
       WHERE migration_name LIKE '%queue_dispatch%'
       ORDER BY migration_name`,
    )).rows.map(({ migration_name }) => migration_name)
    expect(migrations).toEqual([
      '20260915090000_queue_dispatch_job_kinds',
      '20260915090100_queue_dispatch_storage',
      '20260915090200_queue_dispatch_guards',
    ])
  })

  it('requires an explicit dispatch URL and opens the limited dispatch role', async () => {
    expect(() => createDispatchStore('')).toThrowError(
      new DispatchError('DISPATCH_DATABASE_URL_REQUIRED'),
    )
    expect(() => createDispatchStore('https://localhost/s4m_dispatch_test')).toThrowError(
      new DispatchError('DISPATCH_DATABASE_URL_INVALID'),
    )

    const store = createDispatchStore(process.env.DISPATCH_TEST_URL as string)
    try {
      expect((await store.query('SELECT current_user AS role')).rows).toEqual([
        { role: 'scrum4me_dispatch' },
      ])
    } finally {
      await store.end()
    }
  })

  it('seeds the read-only free-task contract and matching job and host slots', async () => {
    const fixture = await harness.seed()

    expect(fixture.actor).toMatchObject({
      userId: expect.any(String),
      principalKey: expect.any(String),
      tokenId: expect.any(String),
      source: 'bearer',
      isDemo: false,
      scopedProducts: [fixture.input.product_id],
      scopedRepos: [],
      tokenKind: 'IMPLEMENTATION',
    })
    expect(fixture.input).toMatchObject({
      version: 1,
      action: 'free_task',
      requirements: { access: 'read', environment_keys: [] },
      publish: 'artifact',
      reply_to: 'mac:jp',
    } satisfies Partial<DispatchInput>)
    expect(fixture.jobSlot.id).not.toBe(fixture.hostSlot.id)
    expect(fixture.jobSlot.incarnationId).not.toBe(fixture.hostSlot.incarnationId)
  })

  it('allows the dispatch role to mutate a managed request and refuses the web role', async () => {
    const fixture = await harness.seed()
    const requestId = randomUUID()
    await harness.dispatch.query(
      `INSERT INTO queue_dispatch_requests
       (id,principal_key,idempotency_key,user_id,product_id,auth_source,input,input_hash,
        snapshot,root_message_id,reply_message_id,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10,now())`,
      [requestId, fixture.actor.principalKey, randomUUID(), fixture.actor.userId,
        fixture.input.product_id, JSON.stringify({ source: 'bearer' }),
        JSON.stringify(fixture.input), 'a'.repeat(64), randomUUID(), randomUUID()],
    )

    for (const role of [harness.web, harness.queue]) {
      await expect(role.query(
        `UPDATE queue_dispatch_requests SET state='RESERVED',version=version+1 WHERE id=$1`,
        [requestId],
      )).rejects.toMatchObject({ code: '42501' })
    }
    await expect(harness.dispatch.query(
      `UPDATE queue_dispatch_requests SET state='RESERVED',version=version+1 WHERE id=$1`,
      [requestId],
    )).resolves.toMatchObject({ rowCount: 1 })
  })

  it('rolls back every write when a transaction callback throws', async () => {
    const fixture = await harness.seed()
    const requestId = randomUUID()

    await expect(withDispatchTransaction(harness.dispatch, async (client) => {
      await client.query(
        `INSERT INTO queue_dispatch_requests
         (id,principal_key,idempotency_key,user_id,product_id,auth_source,input,input_hash,
          snapshot,root_message_id,reply_message_id,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10,now())`,
        [requestId, fixture.actor.principalKey, randomUUID(), fixture.actor.userId,
          fixture.input.product_id, JSON.stringify({ source: 'bearer' }),
          JSON.stringify(fixture.input), 'a'.repeat(64), randomUUID(), randomUUID()],
      )
      throw new Error('EXPECTED_TRANSACTION_FAILURE')
    })).rejects.toThrow('EXPECTED_TRANSACTION_FAILURE')

    expect((await harness.dispatch.query(
      'SELECT count(*)::int AS count FROM queue_dispatch_requests WHERE id=$1',
      [requestId],
    )).rows).toEqual([{ count: 0 }])
  })

  it('reset removes other-user requests and their rows while preserving unrelated data', async () => {
    const fixture = await harness.seed()
    const requestId = randomUUID()
    const eventId = randomUUID()
    const outboxId = randomUUID()
    const artifactId = randomUUID()
    const unrelatedUser = randomUUID()
    await harness.dispatch.query(
      `INSERT INTO queue_dispatch_requests
       (id,principal_key,idempotency_key,user_id,product_id,auth_source,input,input_hash,
        snapshot,root_message_id,reply_message_id,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10,now())`,
      [requestId, `bearer:${fixture.otherUser}`, randomUUID(), fixture.otherUser,
        fixture.input.product_id, JSON.stringify({ source: 'bearer' }),
        JSON.stringify(fixture.input), 'd'.repeat(64), randomUUID(), randomUUID()],
    )
    await harness.dispatch.query(
      `INSERT INTO queue_dispatch_events(id,request_id,type,actor,payload)
       VALUES($1,$2,'FIXTURE_EVENT','{}','{}')`,
      [eventId, requestId],
    )
    await harness.dispatch.query(
      `INSERT INTO queue_dispatch_outbox(id,request_id,version,payload)
       VALUES($1,$2,1,'{}')`,
      [outboxId, requestId],
    )
    await harness.dispatch.query(
      `INSERT INTO queue_dispatch_artifacts(id,request_id,key,sha256,bytes,byte_size)
       VALUES($1,$2,'fixture',$3,$4,1)`,
      [artifactId, requestId, 'e'.repeat(64), Buffer.from([0])],
    )
    await harness.admin.query(
      `INSERT INTO users(id,username,password_hash,updated_at) VALUES($1,$1,'test',now())`,
      [unrelatedUser],
    )

    await harness.reset()

    expect((await harness.admin.query(
      'SELECT id FROM users WHERE id=ANY($1::text[])',
      [[fixture.actor.userId, fixture.otherUser]],
    )).rowCount).toBe(0)
    for (const [table, id] of [
      ['queue_dispatch_requests', requestId],
      ['queue_dispatch_events', eventId],
      ['queue_dispatch_outbox', outboxId],
      ['queue_dispatch_artifacts', artifactId],
    ] as const) {
      expect((await harness.admin.query(
        `SELECT id FROM ${table} WHERE id=$1`,
        [id],
      )).rowCount).toBe(0)
    }
    expect((await harness.admin.query(
      'SELECT id FROM users WHERE id=$1',
      [unrelatedUser],
    )).rowCount).toBe(1)
    await harness.admin.query('DELETE FROM users WHERE id=$1', [unrelatedUser])
  })

  it('barrier releases callers only after the requested count arrives', async () => {
    const barrier = harness.barrier(2)
    let released = false
    const first = barrier().then(() => { released = true })

    await Promise.resolve()
    expect(released).toBe(false)
    await barrier()
    await first
    expect(released).toBe(true)
  })

})
