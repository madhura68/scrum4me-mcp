import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import {
  assertDispatchSchemaRoot, assertDispatchTestUrl, assertTestCluster,
  provisionDispatchTestTarget, readGeneratedRuntimeEnv,
} from './dispatch-test-db.mjs'

// This gate owns a fresh database on a disposable cluster. Never reuse an
// existing database: the provisioner deliberately rebuilds its public schema.
async function main() {
  assertDispatchSchemaRoot(process.env.DISPATCH_TEST_SCHEMA_ROOT)
  const target = assertDispatchTestUrl(process.env.DISPATCH_TEST_ADMIN_URL)
  const cluster = new URL(target)
  cluster.pathname = '/postgres'
  const admin = new Pool({ connectionString: cluster.href, max: 1 })
  try {
    await assertTestCluster(admin)
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname='s4m_dispatch_test'")).rowCount) {
      throw new Error('DISPATCH_TEST_DATABASE_ALREADY_EXISTS')
    }
    await admin.query('CREATE DATABASE s4m_dispatch_test')
  } finally {
    await admin.end()
  }
  const scratch = await mkdtemp(join(tmpdir(), 'mcp-dispatch-ci-'))
  try {
    const env = { ...process.env, DISPATCH_TEST_ENV_FILE: join(scratch, 'runtime.env') }
    await provisionDispatchTestTarget(env)
    const runtime = readGeneratedRuntimeEnv(env.DISPATCH_TEST_ENV_FILE)
    // New projection suites require this fourth restricted runtime identity.
    assertDispatchTestUrl(runtime.DISPATCH_TEST_PROJECTOR_URL)
    const result = spawnSync('npm', ['run', 'test:dispatch'], {
      env: { ...env, ...runtime }, stdio: 'inherit',
    })
    if (result.status !== 0) throw new Error('DISPATCH_TEST_SUITE_FAILED')
    console.log('DISPATCH_CI_PASSED')
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 })
  }
}

main().catch((error) => {
  // Do not print connection strings, generated runtime passwords or SQL errors.
  console.error(error instanceof Error && /^DISPATCH_[A-Z_]+$/.test(error.message)
    ? error.message : 'DISPATCH_CI_FAILED')
  process.exitCode = 1
})
