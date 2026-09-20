import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeDispatchHarness, type DispatchHarness } from './harness.js'
import { running } from './lifecycle-fixtures.js'
import { startDispatchServer, type DispatchRunningServer } from '../../src/dispatch/server.js'

let h: DispatchHarness
const started: DispatchRunningServer[] = []
beforeEach(async () => { h = await makeDispatchHarness() })
afterEach(async () => {
  for (const service of started.splice(0)) await service.close().catch(() => undefined)
  await h.close()
})

/** Every event the entrypoint writes, captured instead of printed. */
function captureLog() {
  const events: Record<string, unknown>[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue
      try { events.push(JSON.parse(line) as Record<string, unknown>) } catch { /* not ours */ }
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  return { events, restore: () => { process.stdout.write = original } }
}

async function start(env: Record<string, string>) {
  const service = startDispatchServer({
    DISPATCH_DATABASE_URL: process.env.DISPATCH_TEST_URL, DISPATCH_HOST: '127.0.0.1', DISPATCH_PORT: '0',
    ...env,
  })
  started.push(service)
  await new Promise<void>(resolve => service.server.once('listening', resolve))
  return { service, url: `http://127.0.0.1:${(service.server.address() as { port: number }).port}` }
}

const exec = promisify(execFile)
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Runtime', GIT_AUTHOR_EMAIL: 'runtime@example.invalid',
  GIT_COMMITTER_NAME: 'Runtime', GIT_COMMITTER_EMAIL: 'runtime@example.invalid' }
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, env: gitEnv })).stdout.trim()

/** The pinned base a repo_write request needs, as a LOCAL bare repository reached over `file://`:
 * no forge, no network and no credential anywhere, but the service's own producer code path. */
async function bareRepository() {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-runtime-forge-'))
  const bare = join(dir, 'fixture.git'), seed = join(dir, 'seed')
  await mkdir(bare); await mkdir(seed)
  await git(bare, 'init', '--bare', '--template=', '--initial-branch=main')
  // Local fixture only: the producer fetches the pinned base by its exact object id.
  await git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  await git(seed, 'init', '--template=', '--initial-branch=main')
  await writeFile(join(seed, 'base.txt'), 'pinned base\n')
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'base')
  const baseSha = await git(seed, 'rev-parse', 'HEAD')
  await git(seed, 'remote', 'add', 'origin', bare)
  await git(seed, 'push', 'origin', 'main')
  return { url: `file://${bare}`, baseSha }
}

/** One seeded product whose registered repository is that local bare repo, plus a real bearer for it. */
async function repoWriteFixture() {
  const forge = await bareRepository()
  const seed = await h.seed()
  const token = `runtime-${randomUUID().replaceAll('-', '')}`
  await h.admin.query('UPDATE api_tokens SET token_hash=$1 WHERE id=$2',
    [createHash('sha256').update(token).digest('hex'), seed.actor.tokenId])
  const productId = seed.input.product_id
  await h.admin.query('UPDATE products SET repo_url=$2 WHERE id=$1', [productId, forge.url])
  const input = { ...seed.input, objective: 'Change exactly the one file the fixture pins.',
    publish: 'branch',
    requirements: { access: 'repo_write', environment_keys: [], repository: { product_id: productId, base_sha: forge.baseSha } } }
  return { forge, productId, token, input }
}
const submit = (url: string, token: string, input: unknown) => fetch(`${url}/dispatch/v1/requests`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
  body: JSON.stringify(input),
})

it('prepares the pinned repository source when a workspace root is configured', async () => {
  const { forge, productId, token, input } = await repoWriteFixture()
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'dispatch-runtime-workspace-')))
  const { service, url } = await start({
    DISPATCH_ENABLED: '1', DISPATCH_PRODUCT_ALLOWLIST: productId, DISPATCH_TICK_INTERVAL_MS: '3600000',
    DISPATCH_WORKSPACE_ROOT: workspaceRoot, DISPATCH_GIT_PROTOCOLS: 'file',
  })
  const submitted = await submit(url, token, input)
  expect(submitted.status).toBe(200)
  const { id } = await submitted.json() as { id: string }

  // The entrypoint's own tick, driven explicitly: preparation is the stage under test, not the timer.
  expect(await service.tick!()).toMatchObject({ prepared: 1, errors: 0 })
  const sources = (await h.dispatch.query<{ key: string }>(
    'SELECT key FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NULL ORDER BY key', [id])).rows.map(r => r.key)
  expect(sources).toContain('__repository_base')
  // The pin is persisted as the service observed it, not as the requester claimed it.
  const prepared = (await h.dispatch.query<{ payload: { repository: { productId: string; repoUrl: string; baseSha: string } | null } }>(
    "SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='sources_prepared'", [id])).rows[0]
  expect(prepared.payload.repository).toMatchObject({ productId, repoUrl: forge.url, baseSha: forge.baseSha })
  expect((await h.dispatch.query('SELECT sources_ready_at FROM queue_dispatch_requests WHERE id=$1', [id])).rows[0].sources_ready_at).not.toBeNull()
  // Nothing of the request's working tree outlives its own preparation.
  expect(await readdir(workspaceRoot)).toEqual([])
})

it('refuses a repo_write request at intake when no workspace root is configured', async () => {
  const { productId, token, input } = await repoWriteFixture()
  const { url } = await start({ DISPATCH_ENABLED: '1', DISPATCH_PRODUCT_ALLOWLIST: productId, DISPATCH_TICK_INTERVAL_MS: '3600000' })
  // A read request on the same deployment is untouched; only the one that would need a producer is refused.
  expect((await submit(url, token, { ...input, publish: 'artifact', requirements: { access: 'read', environment_keys: [] } })).status).toBe(200)
  expect((await submit(url, token, input)).status).toBe(404)
  // No half state: the refused request left no row behind at all.
  const rows = (await h.dispatch.query<{ input: { requirements: { access: string } } }>(
    'SELECT input FROM queue_dispatch_requests WHERE product_id=$1', [productId])).rows
  expect(rows.map(r => r.input.requirements.access)).toEqual(['read'])
})

it('starts its timer only when the entrypoint is called, and shuts down without touching capacity', async () => {
  const x = await running(h)
  const capacity = async () => (await h.dispatch.query<{ attempts: string; reservations: string }>(
    `SELECT (SELECT count(*) FROM queue_dispatch_attempts WHERE state IN ('CLAIMED','RUNNING','UNCERTAIN','CANCEL_REQUESTED')) AS attempts,
            (SELECT count(*) FROM queue_dispatch_reservations WHERE released_at IS NULL) AS reservations`)).rows[0]
  const before = await capacity()
  expect(Number(before.attempts)).toBeGreaterThan(0)

  const log = captureLog()
  try {
    // Importing the module started nothing; an hour-long interval proves the timer is not what ran.
    const { service, url } = await start({ DISPATCH_TICK_INTERVAL_MS: '3600000' })
    expect(log.events.filter(event => 'tick' in event)).toEqual([])
    expect((await fetch(`${url}/healthz`)).status).toBe(200)
    // An explicit tick is the only one that ran, and it is a real one.
    expect(await service.tick!()).toMatchObject({ errors: 0 })
    expect(log.events.filter(event => 'tick' in event)).toEqual([])

    await service.close()
    // Listener first: nothing can arrive any more once close resolves.
    await expect(fetch(`${url}/healthz`)).rejects.toThrow()
    // The open-scope report is written after the tick in flight and before the pools are closed.
    const shutdown = log.events.filter(event => event.shutdown === 'complete')
    expect(shutdown).toHaveLength(1)
    const open = shutdown[0].open_scopes as { attempt_id: string; state: string }[]
    expect(open.map(scope => scope.attempt_id)).toContain(x.proof.attempt_id)
    // A shutdown is not stop evidence: capacity is released by evidence alone.
    expect(await capacity()).toEqual(before)
    await expect(service.store.query('SELECT 1')).rejects.toThrow()
  } finally { log.restore() }
})

it('ticks on its own interval once started, and a second close is harmless', async () => {
  const log = captureLog()
  try {
    const { service } = await start({ DISPATCH_TICK_INTERVAL_MS: '1' })
    // No sleep: the first timer tick is awaited through its own log line.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DISPATCH_TICK_NEVER_RAN')), 20_000)
      const poll = setInterval(() => {
        if (log.events.some(event => 'tick' in event)) { clearInterval(poll); clearTimeout(timeout); resolve() }
      }, 5)
    })
    await service.close()
    const ticks = log.events.filter(event => 'tick' in event).length
    await service.close()
    // Shutdown is idempotent: a second signal ticks nothing, reports nothing twice and does not
    // close an already closed listener or pool.
    expect(log.events.filter(event => 'tick' in event)).toHaveLength(ticks)
    expect(log.events.filter(event => event.shutdown === 'complete')).toHaveLength(1)
  } finally { log.restore() }
})
