import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'

export const DISPATCH_SCHEMA_COMMIT = 'd60cfadefda64206bd347985f508f4e588b8ad2d'
export const requiredUrls = [
  'DISPATCH_TEST_ADMIN_URL',
  'DISPATCH_TEST_URL',
  'DISPATCH_TEST_QUEUE_URL',
  'DISPATCH_TEST_WEB_URL',
]

/** @param {string | undefined} raw @param {NodeJS.ProcessEnv} [env] */
export function assertDispatchTestUrl(raw, env = process.env) {
  if (!raw) throw new Error('DISPATCH_TEST_URL_REQUIRED')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('DISPATCH_TEST_TARGET_REFUSED')
  }
  const hosts = env.CI === 'true' ? ['postgres'] : ['127.0.0.1', 'localhost', '[::1]']
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !hosts.includes(url.hostname)
    || url.pathname !== '/s4m_dispatch_test'
    || url.hash
    || url.search) {
    throw new Error('DISPATCH_TEST_TARGET_REFUSED')
  }
  return url
}

/** @param {string | undefined} raw */
export function assertDispatchSchemaRoot(raw) {
  if (!raw) throw new Error('DISPATCH_TEST_SCHEMA_ROOT_REQUIRED')
  let root
  try {
    root = realpathSync(raw)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (head !== DISPATCH_SCHEMA_COMMIT) throw new Error('commit')
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    if (status.length > 0) throw new Error('dirty')
  } catch {
    throw new Error('DISPATCH_TEST_SCHEMA_ROOT_REFUSED')
  }
  return root
}

/** @param {{query: (sql: string) => Promise<{rows: Array<{production?: boolean}>}>}} client */
export async function assertTestCluster(client) {
  const result = await client.query(
    "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='scrum4me') AS production",
  )
  if (result.rows[0]?.production) throw new Error('DISPATCH_PRODUCTION_CLUSTER_REFUSED')
}

/** @param {NodeJS.ProcessEnv} [env] */
export async function checkDispatchTestTarget(env = process.env) {
  assertDispatchSchemaRoot(env.DISPATCH_TEST_SCHEMA_ROOT)
  const urls = requiredUrls.map((key) => assertDispatchTestUrl(env[key], env))
  if (new Set(urls.map((url) => `${url.hostname}:${url.port}`)).size !== 1) {
    throw new Error('DISPATCH_TEST_TARGET_REFUSED')
  }
  for (const url of urls) {
    const pool = new Pool({ connectionString: url.href, max: 1 })
    try {
      await assertTestCluster(pool)
    } finally {
      await pool.end()
    }
  }
}

/** @param {string} filename */
function readGeneratedRuntimeEnv(filename) {
  /** @type {NodeJS.ProcessEnv} */
  const generated = {}
  for (const line of readFileSync(filename, 'utf8').split('\n')) {
    if (!line) continue
    const match = /^export (DISPATCH_TEST_[A-Z_]+)='([^']*)'$/.exec(line)
    if (!match) throw new Error('DISPATCH_TEST_ENV_FILE_REFUSED')
    generated[match[1]] = match[2]
  }
  for (const key of requiredUrls.slice(1)) {
    if (!generated[key]) throw new Error('DISPATCH_TEST_ENV_FILE_REFUSED')
  }
  return generated
}

/** @param {NodeJS.ProcessEnv} [env] */
export async function provisionDispatchTestTarget(env = process.env) {
  const root = assertDispatchSchemaRoot(env.DISPATCH_TEST_SCHEMA_ROOT)
  const adminUrl = assertDispatchTestUrl(env.DISPATCH_TEST_ADMIN_URL, env)
  if (!env.DISPATCH_TEST_ENV_FILE) throw new Error('DISPATCH_TEST_ENV_FILE_REQUIRED')

  const admin = new Pool({ connectionString: adminUrl.href, max: 1 })
  try {
    await assertTestCluster(admin)
  } finally {
    await admin.end()
  }

  // Repeat the source check immediately before execution so changes made while
  // the cluster sentinel was checked cannot reach the provisioning process.
  assertDispatchSchemaRoot(root)
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=react-server',
      '--import',
      'tsx',
      'scripts/queue-dispatch/provision.ts',
    ],
    { cwd: root, env, stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error('DISPATCH_TEST_PROVISION_FAILED')

  const fresh = readGeneratedRuntimeEnv(env.DISPATCH_TEST_ENV_FILE)
  await checkDispatchTestTarget({ ...env, ...fresh })
}

async function main() {
  try {
    const command = process.argv[2]
    if (command === 'check') {
      await checkDispatchTestTarget()
      console.log('DISPATCH_TEST_TARGET_OK')
      return
    }
    if (command === 'provision') {
      await provisionDispatchTestTarget()
      console.log('DISPATCH_TEST_PROVISION_OK')
      return
    }
    throw new Error('DISPATCH_TEST_COMMAND_REFUSED')
  } catch (error) {
    const message = error instanceof Error && /^DISPATCH_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'DISPATCH_TEST_CONNECTION_FAILED'
    console.error(message)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
