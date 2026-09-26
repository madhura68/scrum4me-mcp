import { describe, it, expect } from 'vitest'
import { buildClaimableJobWhereClause, buildClaimableJobWhereFragment } from '../src/tools/wait-for-job.js'

function sqlText(fragment: { strings: readonly string[] }): string {
  return fragment.strings.join('')
}

describe('claim-filter: local_llm (M2 dedicated IDEA_CHAT-worker)', () => {
  it('local_llm-only worker: Prisma.Sql-variant (live pad) claimt uitsluitend IDEA_CHAT/SYSTEM en nooit NULL-capability-jobs', () => {
    const fragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'CLAUDE',
      hasProductScope: false,
      capabilities: ['local_llm'],
    })
    const text = sqlText(fragment)
    expect(text).toContain("cj.required_capability = 'local_llm'")
    expect(text).toContain("cj.kind = 'IDEA_CHAT'")
    expect(text).toContain("cj.source = 'SYSTEM'")
    expect(text).not.toContain('cj.required_capability IS NULL')
    expect(text).not.toContain("'PR_REVIEW'")
  })

  it('local_llm-only worker: string-variant (buildClaimableJobWhereClause) matcht dezelfde tak (symmetrie)', () => {
    const clause = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false, capabilities: ['local_llm'] })
    expect(clause).toContain("cj.required_capability = 'local_llm'")
    expect(clause).toContain("cj.kind = 'IDEA_CHAT'")
    expect(clause).toContain("cj.source = 'SYSTEM'")
    expect(clause).not.toContain('cj.required_capability IS NULL')
    expect(clause).not.toContain("'PR_REVIEW'")
  })

  it('generieke worker: claimt IDEA_CHAT nog steeds via de NULL/ANY-capability-tak, niet via local_llm', () => {
    const clause = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false, capabilities: ['code_edit', 'planning', 'review'] })
    expect(clause).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
    expect(clause).not.toContain("'local_llm'")
  })
})
