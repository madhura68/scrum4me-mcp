import { describe, expect, it } from 'vitest'
import {
  buildClaimableJobWhereClause,
  buildClaimableJobWhereFragment,
} from '../src/tools/wait-for-job'

function sqlText(fragment: { strings: readonly string[] }): string {
  return fragment.strings.join('')
}

describe('runtime-aware claim filter', () => {
  it('filters by runtime', () => {
    expect(buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })).toContain("cj.runtime = 'CLAUDE'")
  })

  it('allows manual standalone task jobs only through source MANUAL', () => {
    const sql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })

    expect(sql).toContain("cj.kind = 'TASK_IMPLEMENTATION' AND cj.source = 'MANUAL'")
    expect(sql).toContain('cj.sprint_run_id IS NOT NULL')
  })

  it('includes IDEA_REVIEW_PLAN in standalone idea jobs', () => {
    const sql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })

    expect(sql).toContain('IDEA_REVIEW_PLAN')
  })

  it('allows orchestrator follow-up jobs for the matching runtime and capability', () => {
    const sql = buildClaimableJobWhereClause({
      runtime: 'CLAUDE',
      hasProductScope: true,
      capabilities: ['review'],
    })

    expect(sql).toContain("cj.source = 'ORCHESTRATOR'")
    expect(sql).toContain("cj.kind IN ('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'PLAN_CHAT')")
    expect(sql).toContain('cj.task_id IS NULL')
    expect(sql).toContain('cj.idea_id IS NULL')
    expect(sql).toContain('cj.sprint_run_id IS NULL')
    expect(sql).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
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
      "cj.kind IN ('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'PLAN_CHAT')",
      "cj.source = 'ORCHESTRATOR'",
      "OR (cj.kind = 'TASK_IMPLEMENTATION' AND cj.source = 'MANUAL')",
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
})
