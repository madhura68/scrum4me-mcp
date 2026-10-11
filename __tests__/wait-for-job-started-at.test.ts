// started_at van een claude_job begint bij de claim en wordt bij elke terugkeer naar QUEUED gewist.
//
// Zonder dit kreeg een Claude/Codex-job (die nooit 'running' meldt) zijn started_at pas bij het
// terminale update_job_status-rapport, op hetzelfde `now` als finished_at: de duur op de jobkaart
// was dan altijd 0 ("<1 min"). Gemeten 2026-10-11: 469 van 479 PR_REVIEW-jobs van 14 dagen.
// Spiegelt queue/claim.ts, waar de agent_message-claim claimed_at en started_at samen zet.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { executeRawMock, queryRawMock, findUniqueMock } = vi.hoisted(() => ({
  executeRawMock: vi.fn(),
  queryRawMock: vi.fn(),
  findUniqueMock: vi.fn(),
}))

vi.mock('../src/prisma.js', () => {
  const client: Record<string, unknown> = {
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
    claudeJob: { findUnique: findUniqueMock },
    sprintTaskExecution: { deleteMany: vi.fn(), findFirst: vi.fn() },
    sprintRun: { update: vi.fn() },
  }
  client.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(client))
  return { prisma: client }
})
vi.mock('../src/lib/job-notify.js', () => ({ notifyJobChangedPrisma: vi.fn() }))
vi.mock('../src/git/branch-safety.js', () => ({ maybeBackupPush: vi.fn() }))
vi.mock('../src/git/job-locks.js', () => ({
  releaseLocksOnTerminal: vi.fn(),
  setupProductWorktrees: vi.fn(),
}))

import {
  releaseMismatchedClaim,
  resetStaleClaimedJobs,
  rollbackClaim,
  tryClaimJob,
} from '../src/tools/wait-for-job.js'

type SqlCall = unknown[]

function sqlText(call: SqlCall): string {
  const [strings, ...values] = call as [readonly string[], ...unknown[]]
  const parts = [...strings]
  for (const v of values) {
    if (v && typeof v === 'object' && 'strings' in v) parts.push(...(v as { strings: string[] }).strings)
  }
  return parts.join(' ').replace(/\s+/g, ' ')
}

function statements(mock: ReturnType<typeof vi.fn>, startsWith: RegExp): string[] {
  return mock.mock.calls.map(sqlText).filter((s) => startsWith.test(s))
}

beforeEach(() => {
  vi.clearAllMocks()
  executeRawMock.mockResolvedValue(1)
  queryRawMock.mockResolvedValue([])
  findUniqueMock.mockResolvedValue(null)
})

describe('claim', () => {
  it('stamps started_at together with claimed_at', async () => {
    queryRawMock.mockResolvedValueOnce([
      { id: 'j1', implementation_plan: null, sprint_run_id: null, kind: 'PR_REVIEW', idea_id: null },
    ])

    const claimed = await tryClaimJob('u1', 't1', 'i1', undefined, 'CODEX', [], null)

    expect(claimed).toBe('j1')
    const [claim] = statements(executeRawMock, /UPDATE claude_jobs SET status = 'CLAIMED'/)
    expect(claim).toBeDefined()
    expect(claim).toMatch(/claimed_at = NOW\(\)/)
    expect(claim).toMatch(/started_at = NOW\(\)/)
  })
})

describe('requeue clears started_at', () => {
  const requeue = /status = 'QUEUED'/

  it('rollbackClaim with an owner', async () => {
    await rollbackClaim('j1', { tokenId: 'tok', instanceId: 'inst' })
    const [update] = statements(executeRawMock, requeue)
    expect(update).toBeDefined()
    expect(update).toMatch(/claimed_at = NULL/)
    expect(update).toMatch(/started_at = NULL/)
  })

  it('rollbackClaim without an owner', async () => {
    await rollbackClaim('j1', null)
    const [update] = statements(executeRawMock, requeue)
    expect(update).toBeDefined()
    expect(update).toMatch(/started_at = NULL/)
  })

  it('releaseMismatchedClaim', async () => {
    queryRawMock.mockResolvedValueOnce([
      { status: 'CLAIMED', claimed_by_token_id: 'tok', worker_instance_id: 'inst' },
    ])
    await releaseMismatchedClaim('j1', { tokenId: 'tok', instanceId: 'inst' })
    const [update] = statements(executeRawMock, requeue)
    expect(update).toBeDefined()
    expect(update).toMatch(/started_at = NULL/)
  })

  it('the stale-claim sweep', async () => {
    await resetStaleClaimedJobs('u1')
    const [update] = statements(queryRawMock, requeue)
    expect(update).toBeDefined()
    expect(update).toMatch(/claimed_at = NULL/)
    expect(update).toMatch(/started_at = NULL/)
  })
})
