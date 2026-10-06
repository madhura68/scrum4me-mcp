// M45-2b (Taak 2, deel 1): de wegwerp-testdatabase van de dispatch-poort krijgt de twee 2a-migraties van het
// harness-runtime als additieve overlay (scripts/dispatch-test-db.mjs): het enum-lid AgentRuntime.HARNESS en de
// tabellen product_harness_choices en job_cost_reports. Dit bestand bewijst het resultaat in de echte database:
// eigenaar, het ingetrokken CREATE-recht en de rechten gelijk aan de 2a-contracts. De pinnen (commit, paden,
// sha256) en het weigeren van een afwijkende hash staan in token-usage-overlay.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { makeDispatchHarness, type DispatchHarness, type DispatchHarnessSeed } from './harness.js'

const TABLES = ['product_harness_choices', 'job_cost_reports'] as const
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const

let h: DispatchHarness
let f: DispatchHarnessSeed
beforeEach(async () => { h = await makeDispatchHarness(); f = await h.seed() })
afterEach(async () => { await h?.close() })

async function privilegesOf(role: string, table: (typeof TABLES)[number]): Promise<string[]> {
  const granted: string[] = []
  for (const privilege of PRIVILEGES) {
    const { rows } = await h.admin.query<{ granted: boolean }>(
      'SELECT has_table_privilege($1, $2, $3) AS granted', [role, `public.${table}`, privilege],
    )
    if (rows[0].granted) granted.push(privilege)
  }
  return granted
}

describe('2a-overlay in de echte testdatabase', () => {
  it('kent het enum-lid HARNESS achter CLAUDE en CODEX', async () => {
    const { rows } = await h.admin.query<{ value: string }>('SELECT unnest(enum_range(NULL::"AgentRuntime"))::text AS value')
    expect(rows.map((row) => row.value)).toEqual(['CLAUDE', 'CODEX', 'HARNESS'])
  })

  it('maakt beide tabellen aan als scrum4me, net als alle andere tabellen van het schema', async () => {
    const { rows } = await h.admin.query<{ tablename: string; tableowner: string }>(
      `SELECT tablename, tableowner FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename`,
      [[...TABLES]],
    )
    expect(rows).toEqual([
      { tablename: 'job_cost_reports', tableowner: 'scrum4me' },
      { tablename: 'product_harness_choices', tableowner: 'scrum4me' },
    ])
  })

  it('laat scrum4me na de overlay geen CREATE-recht op public houden', async () => {
    const { rows } = await h.admin.query<{ can_create: boolean }>(
      "SELECT has_schema_privilege('scrum4me', 'public', 'CREATE') AS can_create",
    )
    expect(rows[0].can_create).toBe(false)
  })

  it('geeft de rechten van de 2a-contracts: web en prepared-web lezen en schrijven, de observer leest, de rest niets', async () => {
    const expected: Record<string, Record<(typeof TABLES)[number], string[]>> = {
      scrum4me_web_runtime: { product_harness_choices: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], job_cost_reports: ['SELECT', 'INSERT', 'UPDATE'] },
      scrum4me_app: { product_harness_choices: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], job_cost_reports: ['SELECT', 'INSERT', 'UPDATE'] },
      ops_readonly: { product_harness_choices: ['SELECT'], job_cost_reports: ['SELECT'] },
      scrum4me_dispatch: { product_harness_choices: [], job_cost_reports: [] },
      s4m_queue: { product_harness_choices: [], job_cost_reports: [] },
      s4m_dispatch_projector: { product_harness_choices: [], job_cost_reports: [] },
    }
    const actual: Record<string, Record<string, string[]>> = {}
    for (const role of Object.keys(expected)) {
      actual[role] = {}
      for (const table of TABLES) actual[role][table] = await privilegesOf(role, table)
    }
    expect(actual).toEqual(expected)
  })

  it('brengt de CHECK-constraints en sleutels van de tweede migratie mee', async () => {
    const { rows } = await h.admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = ANY($1::regclass[]) AND contype IN ('p', 'c', 'f') ORDER BY conname`,
      [TABLES.map((table) => `public.${table}`)],
    )
    expect(rows.map((row) => row.conname)).toEqual([
      'job_cost_reports_cost_source_check',
      'job_cost_reports_job_id_fkey',
      'job_cost_reports_pkey',
      'job_cost_reports_reported_cost_usd_check',
      'product_harness_choices_configuration_check',
      'product_harness_choices_kind_check',
      'product_harness_choices_max_cost_usd_check',
      'product_harness_choices_pkey',
      'product_harness_choices_product_id_fkey',
    ])
  })

  it('laat de web-rol een keuze lezen en schrijven, en een kostenrij schrijven maar niet verwijderen', async () => {
    const jobId = randomUUID()
    await h.admin.query(
      `INSERT INTO claude_jobs(id, user_id, product_id, kind, source, status, runtime, updated_at)
       VALUES($1, $2, $3, 'TASK_IMPLEMENTATION', 'MANUAL', 'QUEUED', 'HARNESS', now())`,
      [jobId, f.actor.userId, f.input.product_id],
    )
    try {
      await h.web.query(
        `INSERT INTO product_harness_choices(product_id, kind, configuration, max_cost_usd, updated_at)
         VALUES($1, 'IDEA_CHAT', 'qwen3-coder', 0.2, now())`,
        [f.input.product_id],
      )
      expect((await h.web.query('SELECT configuration, max_cost_usd::text AS max_cost_usd FROM product_harness_choices WHERE product_id = $1', [f.input.product_id])).rows)
        .toEqual([{ configuration: 'qwen3-coder', max_cost_usd: '0.2000' }])
      await h.web.query("UPDATE product_harness_choices SET max_cost_usd = 0.5, updated_at = now() WHERE product_id = $1 AND kind = 'IDEA_CHAT'", [f.input.product_id])
      await h.web.query('DELETE FROM product_harness_choices WHERE product_id = $1', [f.input.product_id])

      await h.web.query(
        `INSERT INTO job_cost_reports(job_id, reported_cost_usd, cost_source, configuration)
         VALUES($1, 0.01, 'provider_reported', 'qwen3-coder')`,
        [jobId],
      )
      await h.web.query("UPDATE job_cost_reports SET reported_cost_usd = 0.02 WHERE job_id = $1", [jobId])
      await expect(h.web.query('DELETE FROM job_cost_reports WHERE job_id = $1', [jobId])).rejects.toMatchObject({ code: '42501' })
    } finally {
      // De reset van de harness draait zonder FK-acties, dus de kostenrij gaat hier expliciet weg.
      await h.admin.query('DELETE FROM job_cost_reports WHERE job_id = $1', [jobId])
      await h.admin.query('DELETE FROM product_harness_choices WHERE product_id = $1', [f.input.product_id])
    }
  })
})
