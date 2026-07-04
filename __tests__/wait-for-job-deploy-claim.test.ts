import { describe, it, expect } from 'vitest'
import { buildClaimableJobWhereClause, buildClaimableJobWhereFragment } from '../src/tools/wait-for-job.js'

function sqlText(fragment: { strings: readonly string[] }): string {
  return fragment.strings.join('')
}

describe('claim-filter: DEPLOY (spec §5 + deploy-only-scoping)', () => {
  it('generieke worker: DEPLOY-tak aanwezig voor SYSTEM|MANUAL', () => {
    const clause = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false, capabilities: ['code_edit', 'planning', 'review'] })
    expect(clause).toContain("cj.kind = 'DEPLOY' AND cj.source IN ('SYSTEM', 'MANUAL')")
    expect(clause).toContain('cj.required_capability = ANY') // NULL-tak blijft voor generieke workers
  })

  it('deploy-only worker: claimt uitsluitend DEPLOY en nooit NULL-capability-jobs', () => {
    const clause = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false, capabilities: ['deploy'] })
    expect(clause).toContain("cj.kind = 'DEPLOY'")
    expect(clause).toContain("cj.required_capability = 'deploy'")
    expect(clause).not.toContain('cj.required_capability IS NULL') // geen idea/plan-chat-diefstal
    expect(clause).not.toContain('CLAIMABLE_STANDALONE') // geen standalone-kinds-tak
  })

  it('deploy-only worker: Prisma.Sql-variant (buildClaimableJobWhereFragment) matcht dezelfde deploy-only-tak', () => {
    const fragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'CLAUDE',
      hasProductScope: false,
      capabilities: ['deploy'],
    })
    const text = sqlText(fragment)
    expect(text).toContain("cj.required_capability = 'deploy'")
    expect(text).toContain("cj.kind = 'DEPLOY'")
    expect(text).toContain("cj.source IN ('SYSTEM', 'MANUAL')")
    expect(text).not.toContain('cj.required_capability IS NULL')
    expect(text).not.toContain('CLAIMABLE_STANDALONE')
  })

  it('generieke worker kan DEPLOY nog steeds niet claimen door capability-mismatch (impliciete dekking)', () => {
    // Generieke worker matcht de DEPLOY-OR-tak (kind + source), maar de
    // capability-filter (required_capability IS NULL OR = ANY(caps)) sluit
    // 'm alsnog uit zolang 'deploy' niet in de capability-lijst zit — de
    // AND-combinatie van beide clauses is wat de exclusie afdwingt.
    const clause = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false, capabilities: ['code_edit', 'planning', 'review'] })
    expect(clause).not.toContain("'deploy'")
    expect(clause).toContain('cj.required_capability = ANY')
  })

  it('IDEA_CHAT claimgedrag (PR #60) blijft ongemoeid door de DEPLOY-tak', () => {
    const clause = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false, capabilities: ['code_edit', 'planning', 'review'] })
    expect(clause).toContain("'IDEA_CHAT'")
    expect(clause).toContain("cj.kind IN ('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'IDEA_CHAT', 'PLAN_CHAT', 'PR_REVIEW', 'SPEC_REVIEW', 'TASK_REVIEW')")
  })
})
