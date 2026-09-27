import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTokenUsageMigration, DISPATCH_SCHEMA_COMMIT, TOKEN_USAGE_MIGRATION_COMMIT } from '../../scripts/dispatch-test-db.mjs'

it('keeps historical fixture pin separate from the additive migration', () => {
  expect(DISPATCH_SCHEMA_COMMIT).toBe('6dc581daa7d56bd0e00a82383b3be4bd5d877afb')
  expect(TOKEN_USAGE_MIGRATION_COMMIT).not.toBe(DISPATCH_SCHEMA_COMMIT)
})
it('refuses an unavailable exact migration source', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-source-'))
  try { expect(() => readTokenUsageMigration(root)).toThrow('DISPATCH_USAGE_MIGRATION_SOURCE_REFUSED') }
  finally { rmSync(root, { recursive: true }) }
})
