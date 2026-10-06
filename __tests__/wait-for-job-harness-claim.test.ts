// M45-2b (Taak 2, deel 1): het claimfilter kent een HARNESS-tak. Een worker met runtime HARNESS claimt
// alleen HARNESS-jobs van twee soorten, en geen enkele andere worker claimt ze (spec §5.3).
//
//   cj.runtime = 'HARNESS' AND cj.required_capability IS NULL
//   AND ((cj.kind = 'IDEA_CHAT' AND cj.source = 'SYSTEM')
//     OR (cj.kind = 'TASK_IMPLEMENTATION' AND cj.source = 'COPILOT' AND cj.sprint_run_id IS NULL))
//
// De tak wordt gekozen op de runtime van de worker, vóór de capability-takken: de capabilities van een
// harness-worker tellen niet mee. De tak staat op vier plekken (string-SQL, Prisma-fragment, TS-predicaat
// en SQL-conditie); het TS-predicaat staat in dispatch/eligibility.test.ts, de echte database in
// dispatch/harness-claim.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'

const queryRawMock = vi.fn().mockResolvedValue([])
const executeRawMock = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (cb) => cb({
      $queryRaw: queryRawMock,
      $executeRaw: executeRawMock,
    })),
  },
}))

import {
  buildClaimableJobWhereClause,
  buildClaimableJobWhereFragment,
  buildHigherTierIdleFragment,
  tryClaimJob,
} from '../src/tools/wait-for-job.js'

beforeEach(() => {
  queryRawMock.mockClear()
  executeRawMock.mockClear()
})

/** Tekst van een Prisma.Sql-fragment met `?` als plek van een gebonden waarde, witruimte genormaliseerd. */
function norm(fragment: { strings: readonly string[] }): string {
  return fragment.strings.join('?').replace(/\s+/g, ' ').trim()
}
const normString = (sql: string) => sql.replace(/\s+/g, ' ').trim()

/** De HARNESS-tak, letterlijk uit het contract: precies de soorten van de local_llm-tak, zonder required_capability. */
const HARNESS_BRANCH =
  "cj.required_capability IS NULL AND ((cj.kind = 'IDEA_CHAT' AND cj.source = 'SYSTEM') " +
  "OR (cj.kind = 'TASK_IMPLEMENTATION' AND cj.source = 'COPILOT' AND cj.sprint_run_id IS NULL))"

// Soorten en bronnen van de algemene soortvoorwaarde (CLAIMABLE_JOB_KIND_FILTER): die hoort bij de HARNESS-tak
// niet voor te komen, want de tak is zelf de soortvoorwaarde.
const GENERAL_KIND_FILTER_MARKERS = [
  "cj.kind IN ('IDEA_GRILL'",
  "'PR_REVIEW'",
  "'DEPLOY'",
  "'DOCS_AUDIT'",
  "'PLAN_CHAT'",
  "cj.source <> 'ORCHESTRATOR'",
  "cj.source IN ('MANUAL', 'COPILOT')",
  'sr.status IN',
]

// Alles wat een capability-tak van een andere worker kan opleveren; de runtime van de HARNESS-worker wint.
const CAPABILITY_LISTS: string[][] = [[], ['local_llm'], ['deploy'], ['docs_audit'], ['code_edit', 'review']]
const CAPABILITY_CASES = CAPABILITY_LISTS.map((capabilities) => [capabilities])

describe('claimfilter HARNESS: Prisma.Sql-fragment (het live pad)', () => {
  it.each(CAPABILITY_CASES)('binnen de tak: runtime gebonden, required_capability NULL en de twee soort/bron-combinaties (capabilities %j)', (capabilities) => {
    const fragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'HARNESS',
      hasProductScope: false,
      capabilities,
    })
    const text = norm(fragment)

    // HARNESS wordt op cj.runtime gebonden, niet als literal in de SQL gezet.
    expect(text).toContain('cj.runtime = ?::"AgentRuntime"')
    expect(fragment.values).toContain('HARNESS')
    // De gewone voorwaarden blijven gelden.
    expect(text).toContain('cj.user_id = ?')
    expect(text).toContain("cj.status = 'QUEUED'")
    expect(text).toContain('cj.dispatch_request_id IS NULL')
    // De tak zelf, byte voor byte.
    expect(text).toContain(HARNESS_BRANCH)
    expect(text).toContain('cj.required_capability IS NULL')
    expect(text).toContain("(cj.kind = 'IDEA_CHAT' AND cj.source = 'SYSTEM')")
    expect(text).toContain("(cj.kind = 'TASK_IMPLEMENTATION' AND cj.source = 'COPILOT' AND cj.sprint_run_id IS NULL)")
    // Geen capability-tak van een andere worker, geen gebonden capabilities.
    expect(text).not.toContain("cj.required_capability = 'local_llm'")
    expect(text).not.toContain("cj.required_capability = 'deploy'")
    expect(text).not.toContain("cj.required_capability = 'docs_audit'")
    expect(text).not.toContain('ANY(')
    // Geen algemene soortvoorwaarde: de tak is zelf de soortvoorwaarde.
    for (const marker of GENERAL_KIND_FILTER_MARKERS) expect(text).not.toContain(marker)
  })

  it.each(CAPABILITY_CASES)('de capabilities %j van een harness-worker veranderen niets: dezelfde tekst en dezelfde gebonden waarden', (capabilities) => {
    const withCapabilities = buildClaimableJobWhereFragment({ userId: 'user-1', runtime: 'HARNESS', hasProductScope: false, capabilities })
    const withoutCapabilities = buildClaimableJobWhereFragment({ userId: 'user-1', runtime: 'HARNESS', hasProductScope: false })
    expect(norm(withCapabilities)).toBe(norm(withoutCapabilities))
    expect(withCapabilities.values).toEqual(withoutCapabilities.values)
  })

  it('bindt alleen gebruiker, product en runtime: geen nieuwe gebonden waarden', () => {
    expect(
      buildClaimableJobWhereFragment({ userId: 'user-1', runtime: 'HARNESS', hasProductScope: false, capabilities: ['local_llm'] }).values,
    ).toEqual(['user-1', 'HARNESS'])
    expect(
      buildClaimableJobWhereFragment({ userId: 'user-1', productId: 'product-1', runtime: 'HARNESS', hasProductScope: true, capabilities: ['review'] }).values,
    ).toEqual(['user-1', 'product-1', 'HARNESS'])
  })
})

describe('claimfilter HARNESS: string-SQL (alleen door tests gebruikt, gepind op pariteit)', () => {
  it.each(CAPABILITY_CASES)('geeft dezelfde tak als het live pad (capabilities %j)', (capabilities) => {
    const text = normString(buildClaimableJobWhereClause({ runtime: 'HARNESS', hasProductScope: false, capabilities }))

    expect(text).toContain("cj.runtime = 'HARNESS'")
    expect(text).toContain('cj.user_id = ${userId}')
    expect(text).toContain("cj.status = 'QUEUED'")
    expect(text).toContain('cj.dispatch_request_id IS NULL')
    expect(text).toContain(HARNESS_BRANCH)
    expect(text).not.toContain("cj.required_capability = 'local_llm'")
    expect(text).not.toContain("cj.required_capability = 'deploy'")
    expect(text).not.toContain("cj.required_capability = 'docs_audit'")
    expect(text).not.toContain('ANY(')
    for (const marker of GENERAL_KIND_FILTER_MARKERS) expect(text).not.toContain(marker)
  })

  it('met productscope staat er een productvoorwaarde bij en blijft de tak gelijk', () => {
    const text = normString(buildClaimableJobWhereClause({ runtime: 'HARNESS', hasProductScope: true, capabilities: ['local_llm'] }))
    expect(text).toContain('cj.product_id = ${productId}')
    expect(text).toContain(HARNESS_BRANCH)
  })

  it('de string-SQL en het live pad bevatten dezelfde bouwstenen', () => {
    const spec = normString(buildClaimableJobWhereClause({ runtime: 'HARNESS', hasProductScope: false }))
    const live = norm(buildClaimableJobWhereFragment({ userId: 'user-1', runtime: 'HARNESS', hasProductScope: false }))
    for (const expected of [
      "cj.status = 'QUEUED'",
      'cj.dispatch_request_id IS NULL',
      HARNESS_BRANCH,
    ]) {
      expect(spec).toContain(expected)
      expect(live).toContain(expected)
    }
  })
})

describe('claimfilter HARNESS: tier-fragment (C) telt alleen HARNESS-peers', () => {
  // De peers filteren op w.runtime = <eigen runtime>; de harness geeft geen capability (tier) mee, dus
  // tryClaimJob voegt voor hem geen tier-fragment toe. Een HARNESS-worker die dat toch zou doen, telt
  // alleen HARNESS-peers.
  it('bindt HARNESS op w.runtime en laat de volgorde van de gebonden waarden ongewijzigd', () => {
    const fragment = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'HARNESS',
      selfCapability: 'LOW_P',
    })
    expect(norm(fragment)).toMatch(/w\.runtime\s*=\s*\?::"AgentRuntime"/)
    expect(fragment.values).toEqual(['u1', 'HARNESS', 'i1', 'LOW_P'])
  })

  it('met een HARNESS-worker als zichzelf komt er geen Claude- of Codex-runtime in het fragment', () => {
    const fragment = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'HARNESS',
      selfCapability: 'HIGH_P',
    })
    expect(fragment.values).not.toContain('CLAUDE')
    expect(fragment.values).not.toContain('CODEX')
  })
})

describe('tryClaimJob met runtime HARNESS (de bedrading naar het filter)', () => {
  function claimQueryTexts(): { whereText: string; whereValues: unknown[]; allText: string } {
    const fragments = queryRawMock.mock.calls[0]
      .flat()
      .filter((v): v is Prisma.Sql => v && typeof v === 'object' && 'strings' in v)
    return {
      whereText: norm(fragments[0]),
      whereValues: fragments[0].values,
      allText: fragments.map((f) => norm(f)).join(' '),
    }
  }

  it('geeft de runtime door aan het filter: de HARNESS-tak, gebonden runtime, geen algemene soortvoorwaarde', async () => {
    await tryClaimJob('u1', 't1', 'i1', undefined, 'HARNESS', [], null)
    expect(queryRawMock).toHaveBeenCalled()
    const { whereText, whereValues } = claimQueryTexts()
    expect(whereText).toContain(HARNESS_BRANCH)
    expect(whereValues).toContain('HARNESS')
    for (const marker of GENERAL_KIND_FILTER_MARKERS) expect(whereText).not.toContain(marker)
  })

  it('een harness-worker met capabilities [local_llm] krijgt dezelfde tak (runtime wint)', async () => {
    await tryClaimJob('u1', 't1', 'i1', undefined, 'HARNESS', ['local_llm'], null)
    const { whereText } = claimQueryTexts()
    expect(whereText).toContain(HARNESS_BRANCH)
    expect(whereText).not.toContain("cj.required_capability = 'local_llm'")
  })

  it('met productscope blijft de tak gelijk en komt het product erbij', async () => {
    await tryClaimJob('u1', 't1', 'i1', 'product-1', 'HARNESS', [], null)
    const { whereText, whereValues } = claimQueryTexts()
    expect(whereText).toContain(HARNESS_BRANCH)
    expect(whereValues).toEqual(['u1', 'product-1', 'HARNESS'])
  })

  it('zonder capability (tier) komt er geen tier-fragment bij: de harness geeft er geen mee', async () => {
    await tryClaimJob('u1', 't1', 'i1', undefined, 'HARNESS', [], null)
    expect(claimQueryTexts().allText).not.toContain('FROM claude_workers w')
  })
})
