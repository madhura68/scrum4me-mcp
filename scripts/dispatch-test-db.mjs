import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'

export const DISPATCH_SCHEMA_COMMIT = '6dc581daa7d56bd0e00a82383b3be4bd5d877afb'
// Additive migration only; retain the historical schema and its policy proof.
export const TOKEN_USAGE_MIGRATION_COMMIT = 'bd3f5eaeabc8d4cefd959698824b677bb78cbcc2'
export const TOKEN_USAGE_MIGRATION_PATH = 'prisma/migrations/20260927170000_api_token_last_used_at/migration.sql'
export const TOKEN_USAGE_MIGRATION_SHA256 = '18d535b2c96b2674d8673c0b3f768de6cabd2f0afce2de054252ec8316bf55ba'

/** @param {string} root */
export function readTokenUsageMigration(root) {
  let sql
  try {
    sql = execFileSync('git', ['show', `${TOKEN_USAGE_MIGRATION_COMMIT}:${TOKEN_USAGE_MIGRATION_PATH}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { throw new Error('DISPATCH_USAGE_MIGRATION_SOURCE_REFUSED') }
  if (createHash('sha256').update(sql).digest('hex') !== TOKEN_USAGE_MIGRATION_SHA256) {
    throw new Error('DISPATCH_USAGE_MIGRATION_HASH_REFUSED')
  }
  return sql
}

// M45-2a: the two additive migrations of the HARNESS runtime (the enum member, then the tables
// product_harness_choices and job_cost_reports), on top of the same historical schema. Same rule as the token-usage
// migration above: an immutable pin of commit, path and sha256, read with `git show` from the schema source, never a
// replacement baseline. The order matters: a new enum member cannot be used in the transaction that adds it, so the
// two files are two separate queries.
export const HARNESS_MIGRATION_COMMIT = 'ae6483b294522803eadf97937842cd7c2456ff31'
export const HARNESS_MIGRATIONS = [
  {
    path: 'prisma/migrations/20261006120000_agent_runtime_harness/migration.sql',
    sha256: '9a9e23cccf151a4548419ede24727da29ca71c3f8110328b0766e6dce10203b5',
  },
  {
    path: 'prisma/migrations/20261006120100_harness_choices_cost_reports/migration.sql',
    sha256: '2f5127079fb6b02352d5a6ae1c1059fffe871ead2650b3db77c82275e6d7ceac',
  },
]

// Rights equal to the 2a contracts (scripts/db-access/profiles/scrum4me.json on the commit above): web and
// prepared-web read and write product_harness_choices, job_cost_reports has no DELETE (the cascade from claude_jobs
// does not need it) and the observer only reads. The dispatch, queue and projector roles get nothing.
export const HARNESS_GRANTS = [
  'GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_harness_choices TO scrum4me_web_runtime, scrum4me_app',
  'GRANT SELECT, INSERT, UPDATE ON public.job_cost_reports TO scrum4me_web_runtime, scrum4me_app',
  'GRANT SELECT ON public.product_harness_choices, public.job_cost_reports TO ops_readonly',
]

/**
 * @param {string} root
 * @param {{ commit?: string, migrations?: ReadonlyArray<{ path: string, sha256: string }> }} [pins]
 *   Only a test passes pins of its own; the defaults are the immutable pins above.
 * @returns {string[]} the migrations in pin order
 */
export function readHarnessMigrations(root, pins = {}) {
  const commit = pins.commit ?? HARNESS_MIGRATION_COMMIT
  return (pins.migrations ?? HARNESS_MIGRATIONS).map(({ path, sha256 }) => {
    let sql
    try {
      sql = execFileSync('git', ['show', `${commit}:${path}`], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch { throw new Error('DISPATCH_HARNESS_MIGRATION_SOURCE_REFUSED') }
    if (createHash('sha256').update(sql).digest('hex') !== sha256) {
      throw new Error('DISPATCH_HARNESS_MIGRATION_HASH_REFUSED')
    }
    return sql
  })
}

/**
 * Applies the migrations as the schema owner under a temporary CREATE right on `public` (that schema belongs to
 * pg_database_owner, so CREATE TABLE as `scrum4me` fails without it), the same pattern as the additive migrations of
 * the provisioner. The right is revoked in `finally`: a failure halfway never leaves `scrum4me` with a lasting
 * CREATE. SET ROLE lives in the session, so this needs ONE connection, not a pool.
 * @param {{ query: (sql: string) => Promise<unknown> }} client
 * @param {readonly string[]} migrations in order, the enum member first, each as its own query
 */
export async function applyHarnessOverlay(client, migrations) {
  try {
    await client.query('GRANT CREATE ON SCHEMA public TO scrum4me; SET ROLE scrum4me')
    for (const sql of migrations) await client.query(sql)
  } finally {
    await client.query('RESET ROLE; REVOKE CREATE ON SCHEMA public FROM scrum4me')
  }
  for (const grant of HARNESS_GRANTS) await client.query(grant)
}

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
  const root = assertDispatchSchemaRoot(env.DISPATCH_TEST_SCHEMA_ROOT)
  readTokenUsageMigration(root)
  readHarnessMigrations(root)
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
export function readGeneratedRuntimeEnv(filename) {
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
  // Verified before the provisioner touches the database, so a wrong source fails fast.
  const harnessMigrations = readHarnessMigrations(root)
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

  // The source has a separate immutable pin, never a replacement historical baseline.
  const overlay = new Pool({ connectionString: adminUrl.href, max: 1 })
  try {
    await assertTestCluster(overlay)
    await overlay.query(readTokenUsageMigration(root))
    // JP approved only this column right for the existing dispatch role.
    await overlay.query('GRANT UPDATE(last_used_at) ON public.api_tokens TO scrum4me_dispatch')
    // M45-2a: the HARNESS enum member and tables, on one connection (SET ROLE lives in the session).
    const client = await overlay.connect()
    try { await applyHarnessOverlay(client, harnessMigrations) } finally { client.release() }
  } finally { await overlay.end() }

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
