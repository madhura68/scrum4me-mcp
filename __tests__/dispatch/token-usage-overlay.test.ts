import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyHarnessOverlay,
  DISPATCH_SCHEMA_COMMIT,
  HARNESS_GRANTS,
  HARNESS_MIGRATION_COMMIT,
  HARNESS_MIGRATIONS,
  readHarnessMigrations,
  readTokenUsageMigration,
  TOKEN_USAGE_MIGRATION_COMMIT,
} from '../../scripts/dispatch-test-db.mjs'

it('keeps historical fixture pin separate from the additive migration', () => {
  expect(DISPATCH_SCHEMA_COMMIT).toBe('6dc581daa7d56bd0e00a82383b3be4bd5d877afb')
  expect(TOKEN_USAGE_MIGRATION_COMMIT).not.toBe(DISPATCH_SCHEMA_COMMIT)
})
it('refuses an unavailable exact migration source', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-source-'))
  try { expect(() => readTokenUsageMigration(root)).toThrow('DISPATCH_USAGE_MIGRATION_SOURCE_REFUSED') }
  finally { rmSync(root, { recursive: true }) }
})

// M45-2b (Taak 2, deel 1): de CI-testdatabase krijgt de twee 2a-migraties van het harness-runtime
// (het enum-lid en de twee tabellen) als tweede additieve overlay, naar het voorbeeld van de
// token-usage-overlay hierboven. De historische pin blijft staan.
const HARNESS_ENUM_PATH = 'prisma/migrations/20261006120000_agent_runtime_harness/migration.sql'
const HARNESS_TABLES_PATH = 'prisma/migrations/20261006120100_harness_choices_cost_reports/migration.sql'
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Een wegwerp-gitbron met precies deze bestanden, op één commit. */
function throwawaySource(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'harness-source-'))
  const git = (...args: string[]) => execFileSync(
    'git',
    ['-c', 'user.email=overlay@example.test', '-c', 'user.name=overlay', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    },
  )
  git('init', '--quiet')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git('add', '--all')
  git('commit', '--quiet', '-m', 'fixture')
  return { root, commit: git('rev-parse', 'HEAD').trim() }
}

describe('harness overlay: de twee 2a-migraties als additieve pin', () => {
  it('pint commit, paden en sha256 van beide migraties, in de volgorde enum-lid eerst', () => {
    expect(HARNESS_MIGRATION_COMMIT).toBe('ae6483b294522803eadf97937842cd7c2456ff31')
    expect(HARNESS_MIGRATIONS).toEqual([
      { path: HARNESS_ENUM_PATH, sha256: '9a9e23cccf151a4548419ede24727da29ca71c3f8110328b0766e6dce10203b5' },
      { path: HARNESS_TABLES_PATH, sha256: '2f5127079fb6b02352d5a6ae1c1059fffe871ead2650b3db77c82275e6d7ceac' },
    ])
  })

  it('houdt de overlay los van de historische schema-pin en van de token-usage-pin', () => {
    expect(DISPATCH_SCHEMA_COMMIT).toBe('6dc581daa7d56bd0e00a82383b3be4bd5d877afb')
    expect(HARNESS_MIGRATION_COMMIT).not.toBe(DISPATCH_SCHEMA_COMMIT)
    expect(HARNESS_MIGRATION_COMMIT).not.toBe(TOKEN_USAGE_MIGRATION_COMMIT)
  })

  it('weigert een bron waarin de vastgepinde commit niet beschikbaar is', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-source-'))
    try { expect(() => readHarnessMigrations(root)).toThrow('DISPATCH_HARNESS_MIGRATION_SOURCE_REFUSED') }
    finally { rmSync(root, { recursive: true }) }
  })

  it('weigert een bron waarin een van de vastgepinde paden ontbreekt', () => {
    const enumSql = 'ALTER TYPE "AgentRuntime" ADD VALUE IF NOT EXISTS \'HARNESS\';\n'
    const source = throwawaySource({ [HARNESS_ENUM_PATH]: enumSql })
    try {
      expect(() => readHarnessMigrations(source.root, {
        commit: source.commit,
        migrations: [
          { path: HARNESS_ENUM_PATH, sha256: sha256(enumSql) },
          { path: HARNESS_TABLES_PATH, sha256: sha256('ontbreekt') },
        ],
      })).toThrow('DISPATCH_HARNESS_MIGRATION_SOURCE_REFUSED')
    } finally { rmSync(source.root, { recursive: true }) }
  })

  it('weigert een migratie waarvan de sha256 afwijkt van de pin, ook als alleen de tweede afwijkt', () => {
    const enumSql = 'ALTER TYPE "AgentRuntime" ADD VALUE IF NOT EXISTS \'HARNESS\';\n'
    const tablesSql = 'CREATE TABLE "product_harness_choices" ("product_id" TEXT NOT NULL);\n'
    const source = throwawaySource({ [HARNESS_ENUM_PATH]: enumSql, [HARNESS_TABLES_PATH]: tablesSql })
    try {
      expect(() => readHarnessMigrations(source.root, {
        commit: source.commit,
        migrations: [
          { path: HARNESS_ENUM_PATH, sha256: sha256(enumSql) },
          { path: HARNESS_TABLES_PATH, sha256: sha256(`${tablesSql}-- gewijzigd\n`) },
        ],
      })).toThrow('DISPATCH_HARNESS_MIGRATION_HASH_REFUSED')
      expect(() => readHarnessMigrations(source.root, {
        commit: source.commit,
        migrations: [
          { path: HARNESS_ENUM_PATH, sha256: '0'.repeat(64) },
          { path: HARNESS_TABLES_PATH, sha256: sha256(tablesSql) },
        ],
      })).toThrow('DISPATCH_HARNESS_MIGRATION_HASH_REFUSED')
    } finally { rmSync(source.root, { recursive: true }) }
  })

  it('geeft de migraties terug in pin-volgorde als elke sha256 klopt', () => {
    const enumSql = 'ALTER TYPE "AgentRuntime" ADD VALUE IF NOT EXISTS \'HARNESS\';\n'
    const tablesSql = 'CREATE TABLE "product_harness_choices" ("product_id" TEXT NOT NULL);\n'
    const source = throwawaySource({ [HARNESS_ENUM_PATH]: enumSql, [HARNESS_TABLES_PATH]: tablesSql })
    try {
      expect(readHarnessMigrations(source.root, {
        commit: source.commit,
        migrations: [
          { path: HARNESS_ENUM_PATH, sha256: sha256(enumSql) },
          { path: HARNESS_TABLES_PATH, sha256: sha256(tablesSql) },
        ],
      })).toEqual([enumSql, tablesSql])
    } finally { rmSync(source.root, { recursive: true }) }
  })
})

describe('harness overlay: toepassen onder een tijdelijk CREATE-recht', () => {
  const ENUM_SQL = 'ENUM-LID'
  const TABLES_SQL = 'TABELLEN'
  const GRANT_CREATE = 'GRANT CREATE ON SCHEMA public TO scrum4me; SET ROLE scrum4me'
  const REVOKE_CREATE = 'RESET ROLE; REVOKE CREATE ON SCHEMA public FROM scrum4me'

  it('geeft CREATE, past beide migraties als aparte queries toe (enum-lid eerst), trekt CREATE in en geeft dan de rechten', async () => {
    const seen: string[] = []
    await applyHarnessOverlay({ query: async (sql: string) => { seen.push(sql) } }, [ENUM_SQL, TABLES_SQL])
    expect(seen).toEqual([GRANT_CREATE, ENUM_SQL, TABLES_SQL, REVOKE_CREATE, ...HARNESS_GRANTS])
  })

  it('trekt het CREATE-recht ook in als een migratie halverwege faalt, en geeft dan geen rechten', async () => {
    const seen: string[] = []
    const client = {
      query: async (sql: string) => {
        seen.push(sql)
        if (sql === TABLES_SQL) throw new Error('boom')
      },
    }
    await expect(applyHarnessOverlay(client, [ENUM_SQL, TABLES_SQL])).rejects.toThrow('boom')
    expect(seen).toEqual([GRANT_CREATE, ENUM_SQL, TABLES_SQL, REVOKE_CREATE])
  })

  it('trekt het CREATE-recht ook in als het enum-lid faalt: de tabellen worden dan niet meer aangemaakt', async () => {
    const seen: string[] = []
    const client = {
      query: async (sql: string) => {
        seen.push(sql)
        if (sql === ENUM_SQL) throw new Error('boom')
      },
    }
    await expect(applyHarnessOverlay(client, [ENUM_SQL, TABLES_SQL])).rejects.toThrow('boom')
    expect(seen).toEqual([GRANT_CREATE, ENUM_SQL, REVOKE_CREATE])
  })

  it('geeft alleen rechten die de 2a-contracts noemen: geen DELETE op job_cost_reports, niets voor de dispatch-rollen', () => {
    const text = HARNESS_GRANTS.join('\n')
    expect(text).toContain('product_harness_choices')
    expect(text).toContain('job_cost_reports')
    for (const role of ['scrum4me_dispatch', 's4m_queue', 's4m_dispatch_projector']) expect(text).not.toContain(role)
    expect(HARNESS_GRANTS.filter((grant) => grant.includes('job_cost_reports') && /\bDELETE\b/.test(grant))).toEqual([])
  })
})
