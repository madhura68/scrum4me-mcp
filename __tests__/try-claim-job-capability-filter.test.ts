import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { tryClaimJob } from '../src/tools/wait-for-job.js'

beforeEach(() => {
  queryRawMock.mockClear()
  executeRawMock.mockClear()
})

describe('tryClaimJob with caller capability', () => {
  it('includes higher-tier-idle clause when capability passed', async () => {
    await tryClaimJob('u1', 't1', 'i1', undefined, 'CLAUDE', [], 'MEDIUM_P')
    expect(queryRawMock).toHaveBeenCalled()
    const fragments = queryRawMock.mock.calls[0]
      .flat()
      .filter((v): v is { strings: string[] } => v && typeof v === 'object' && 'strings' in v)
    const text = fragments.flatMap((f) => f.strings).join(' ')
    // 2026-06-08: tier-fragment uses CASE-priority instead of bare w.capability > selfCapability
    // (see docs/superpowers/plans/2026-06-08-tier-preference-enum-ordinal-fix.md).
    expect(text).toMatch(/CASE w\.capability\s+WHEN 'HIGH_P' THEN 3\s+WHEN 'MEDIUM_P' THEN 2\s+WHEN 'LOW_P' THEN 1\s+END/i)
    expect(text).toMatch(/k\.status IN \('CLAIMED','RUNNING'\)/i)
  })

  it('omits clause when capability is null', async () => {
    await tryClaimJob('u1', 't1', 'i1', undefined, 'CLAUDE', [], null)
    const fragments = queryRawMock.mock.calls[0]
      .flat()
      .filter((v): v is { strings: string[] } => v && typeof v === 'object' && 'strings' in v)
    const text = fragments.flatMap((f) => f.strings).join(' ')
    // Tier-fragment must be omitted entirely (Prisma.empty) when caller capability is null —
    // post-fix the marker is the CASE-priority shape, not the bare comparison.
    expect(text).not.toMatch(/CASE w\.capability\s+WHEN 'HIGH_P'/i)
  })
})

describe('tryClaimJob claimable-kind filter', () => {
  // Regressie 2026-07-06: een enkelvoudige COPILOT-task-dispatch
  // (dispatchTaskImplementation, IDEA-118 §6.3) maakt een TASK_IMPLEMENTATION
  // met source='COPILOT' + task_id (door de DB-constraint expliciet toegestaan),
  // maar de claim-filter liet alleen source='MANUAL' of een sprint_run toe →
  // job bleef eeuwig QUEUED. De filter moet COPILOT-task-jobs claimbaar maken.
  it('allows standalone COPILOT TASK_IMPLEMENTATION jobs to be claimed', async () => {
    await tryClaimJob('u1', 't1', 'i1', undefined, 'CLAUDE', [], null)
    const fragments = queryRawMock.mock.calls[0]
      .flat()
      .filter((v): v is { strings: string[] } => v && typeof v === 'object' && 'strings' in v)
    const text = fragments.flatMap((f) => f.strings).join(' ')
    expect(text).toMatch(/cj\.kind = 'TASK_IMPLEMENTATION' AND cj\.source IN \('MANUAL', 'COPILOT'\)/i)
  })
})
