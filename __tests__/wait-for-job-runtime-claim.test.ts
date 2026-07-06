import { describe, expect, it } from 'vitest'
import {
  buildClaimableJobWhereClause,
  buildClaimableJobWhereFragment,
} from '../src/tools/wait-for-job'
import { parseWorkerRuntime } from '../src/worker-runtime'

function sqlText(fragment: { strings: readonly string[] }): string {
  return fragment.strings.join('')
}

function sqlValues(fragment: { values?: readonly unknown[] }): readonly unknown[] {
  return fragment.values ?? []
}

describe('runtime-aware claim filter', () => {
  it('parses SCRUM4ME_WORKER_RUNTIME case-insensitively and defaults to CLAUDE', () => {
    expect(parseWorkerRuntime('CODEX')).toBe('CODEX')
    expect(parseWorkerRuntime('codex')).toBe('CODEX')
    expect(parseWorkerRuntime(' claude ')).toBe('CLAUDE')
    expect(parseWorkerRuntime('')).toBe('CLAUDE')
    expect(parseWorkerRuntime('gpt-5')).toBe('CLAUDE')
    expect(parseWorkerRuntime(undefined)).toBe('CLAUDE')
  })

  it('filters by runtime', () => {
    expect(buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })).toContain("cj.runtime = 'CLAUDE'")
  })

  it('builds Claude claim SQL that cannot match CODEX jobs', () => {
    const specSql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })
    const productionFragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'CLAUDE',
      hasProductScope: false,
    })

    expect(specSql).toContain("cj.runtime = 'CLAUDE'")
    expect(specSql).not.toContain("cj.runtime = 'CODEX'")
    expect(sqlText(productionFragment)).toContain('cj.runtime = ')
    expect(sqlValues(productionFragment)).toContain('CLAUDE')
    expect(sqlValues(productionFragment)).not.toContain('CODEX')
  })

  it('builds Codex claim SQL that cannot match CLAUDE jobs', () => {
    const specSql = buildClaimableJobWhereClause({ runtime: 'CODEX', hasProductScope: false })
    const productionFragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'CODEX',
      hasProductScope: false,
    })

    expect(specSql).toContain("cj.runtime = 'CODEX'")
    expect(specSql).not.toContain("cj.runtime = 'CLAUDE'")
    expect(sqlText(productionFragment)).toContain('cj.runtime = ')
    expect(sqlValues(productionFragment)).toContain('CODEX')
    expect(sqlValues(productionFragment)).not.toContain('CLAUDE')
  })

  it('allows standalone task jobs through source MANUAL or COPILOT', () => {
    const sql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })

    // 2026-07-06: COPILOT single-task dispatch (dispatchTaskImplementation,
    // IDEA-118 §6.3) is door de DB-constraint toegestaan maar bleef eeuwig
    // QUEUED zolang de claim-filter alleen MANUAL toeliet.
    expect(sql).toContain("cj.kind = 'TASK_IMPLEMENTATION' AND cj.source IN ('MANUAL', 'COPILOT')")
    expect(sql).toContain('cj.sprint_run_id IS NOT NULL')
  })

  it('includes IDEA_REVIEW_PLAN in standalone idea jobs', () => {
    const sql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })

    expect(sql).toContain('IDEA_REVIEW_PLAN')
  })

  it('includes IDEA_CHAT in standalone idea jobs (M17 idea-chat)', () => {
    const sql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })

    expect(sql).toContain("'IDEA_CHAT'")
  })

  it('allows only PLAN_CHAT orchestrator follow-up jobs for the matching runtime and capability', () => {
    const sql = buildClaimableJobWhereClause({
      runtime: 'CLAUDE',
      hasProductScope: true,
      capabilities: ['review'],
    })

    expect(sql).toContain("cj.source = 'ORCHESTRATOR'")
    expect(sql).toContain("cj.kind = 'PLAN_CHAT'")
    expect(sql).toContain('cj.task_id IS NULL')
    expect(sql).toContain('cj.idea_id IS NULL')
    expect(sql).toContain('cj.sprint_run_id IS NULL')
    expect(sql).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
  })

  it('preserves the orchestrator follow-up guard in the production claim fragment', () => {
    const productionSql = sqlText(
      buildClaimableJobWhereFragment({
        userId: 'user-1',
        productId: 'product-1',
        runtime: 'CLAUDE',
        hasProductScope: true,
        capabilities: ['queue_orchestration'],
      }),
    )

    expect(productionSql).toContain("cj.kind = 'PLAN_CHAT'")
    expect(productionSql).toContain("cj.source = 'ORCHESTRATOR'")
    expect(productionSql).toContain('cj.task_id IS NULL')
    expect(productionSql).toContain('cj.idea_id IS NULL')
    expect(productionSql).toContain('cj.sprint_run_id IS NULL')
    expect(productionSql).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
  })

  it('keeps the production SQL fragment aligned with the exported spec clause', () => {
    const specSql = buildClaimableJobWhereClause({
      runtime: 'CODEX',
      hasProductScope: true,
      capabilities: ['planning'],
    })
    const productionSql = sqlText(
      buildClaimableJobWhereFragment({
        userId: 'user-1',
        productId: 'product-1',
        runtime: 'CODEX',
        hasProductScope: true,
        capabilities: ['planning'],
      }),
    )

    for (const expected of [
      'cj.product_id = ',
      "cj.kind IN ('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'IDEA_CHAT', 'PLAN_CHAT', 'PR_REVIEW', 'SPEC_REVIEW', 'TASK_REVIEW')",
      "cj.kind = 'PLAN_CHAT'",
      "cj.source = 'ORCHESTRATOR'",
      "OR (cj.kind = 'TASK_IMPLEMENTATION' AND cj.source IN ('MANUAL', 'COPILOT'))",
      'cj.sprint_run_id IS NOT NULL',
      "sr.status IN ('QUEUED', 'RUNNING')",
      'cj.required_capability IS NULL',
      'cj.required_capability = ANY',
      '::text[]',
    ]) {
      expect(specSql).toContain(expected)
      expect(productionSql).toContain(expected)
    }

    expect(productionSql).toContain('cj.runtime = ')
    expect(productionSql).toContain('::"AgentRuntime"')
  })

  it('requires NULL required_capability when worker has no capabilities', () => {
    const specSql = buildClaimableJobWhereClause({
      runtime: 'CLAUDE',
      hasProductScope: false,
      capabilities: [],
    })
    const productionSql = sqlText(
      buildClaimableJobWhereFragment({
        userId: 'user-1',
        runtime: 'CLAUDE',
        hasProductScope: false,
        capabilities: [],
      }),
    )

    expect(specSql).toContain('cj.required_capability IS NULL')
    expect(specSql).not.toContain('ANY')
    expect(productionSql).toContain('cj.required_capability IS NULL')
    expect(productionSql).not.toContain('ANY')
  })

  it('lets workers with non-planning capabilities match only NULL or listed required capabilities', () => {
    const specSql = buildClaimableJobWhereClause({
      runtime: 'CLAUDE',
      hasProductScope: false,
      capabilities: ['review'],
    })
    const productionFragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'CLAUDE',
      hasProductScope: false,
      capabilities: ['review'],
    })

    expect(specSql).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
    expect(sqlText(productionFragment)).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
    expect(sqlValues(productionFragment)).toContainEqual(['review'])
    expect(sqlValues(productionFragment)).not.toContainEqual(['planning'])
  })
})
