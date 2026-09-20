import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('refuses a missing schema source before connecting or provisioning', () => {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('DISPATCH_TEST_')))
  const result = spawnSync(process.execPath, ['scripts/run-dispatch-ci.mjs'], {
    cwd: new URL('../..', import.meta.url), env, encoding: 'utf8',
  })
  expect(result.status).toBe(1)
  expect(result.stderr.trim()).toBe('DISPATCH_TEST_SCHEMA_ROOT_REQUIRED')
})
