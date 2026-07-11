import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryRawMock = vi.fn().mockResolvedValue([])

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (cb) => cb({
      $queryRaw: queryRawMock,
      $executeRaw: vi.fn(),
    })),
  },
}))

import { tryClaimJob } from '../src/tools/wait-for-job.js'

type FixtureJob = {
  id: string
  sprint_run_id: string
  sprint_sequence: number | null
  status: 'QUEUED' | 'CLAIMED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED' | 'SKIPPED'
  created_at: number
}

const activeStatuses = new Set<FixtureJob['status']>(['QUEUED', 'CLAIMED', 'RUNNING'])

function claimableFixtureJobs(jobs: FixtureJob[]): FixtureJob[] {
  return jobs
    .filter((candidate) => candidate.status === 'QUEUED')
    .filter((candidate) => !jobs.some((earlier) =>
      earlier.sprint_run_id === candidate.sprint_run_id &&
      earlier.sprint_sequence !== null &&
      candidate.sprint_sequence !== null &&
      earlier.sprint_sequence < candidate.sprint_sequence &&
      activeStatuses.has(earlier.status),
    ))
    .sort((a, b) =>
      a.created_at - b.created_at ||
      (a.sprint_sequence ?? 2147483647) - (b.sprint_sequence ?? 2147483647) ||
      a.id.localeCompare(b.id),
    )
}

function claimSql(): string {
  const collectStrings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(collectStrings)
    if (value && typeof value === 'object' && 'strings' in value) {
      return collectStrings((value as { strings: string[] }).strings)
    }
    return []
  }

  return collectStrings(queryRawMock.mock.calls[0])
    .join(' ')
    .replace(/\s+/g, ' ')
}

beforeEach(() => {
  queryRawMock.mockClear()
})

describe('tryClaimJob sprint sequence barrier', () => {
  it.each([
    ['zonder productscope', undefined],
    ['met productscope', 'product-1'],
  ])('blokkeert later per-task sprintwerk in de %s claimquery', async (_label, productId) => {
    await tryClaimJob('user-1', 'token-1', 'instance-1', productId)

    const sql = claimSql()
    expect(sql).toContain('earlier.sprint_sequence < cj.sprint_sequence')
    expect(sql).toContain("earlier.status IN ('QUEUED','CLAIMED','RUNNING')")
    expect(sql).toContain('COALESCE(cj.sprint_sequence, 2147483647)')
    expect(sql).toContain('cj.id ASC')
  })

  it('laat legacy NULL-sequence jobs tijdens de uitrol claimbaar', async () => {
    await tryClaimJob('user-1', 'token-1', 'instance-1')

    const sql = claimSql()
    expect(sql).toContain('earlier.sprint_sequence < cj.sprint_sequence')
    expect(sql).not.toMatch(/cj\.sprint_sequence\s+IS\s+NOT\s+NULL/i)
    expect(sql).toContain('COALESCE(cj.sprint_sequence, 2147483647)')

    const mixedJobs: FixtureJob[] = [
      { id: 'legacy', sprint_run_id: 'run-1', sprint_sequence: null, status: 'QUEUED', created_at: 1 },
      { id: 'sequence-0', sprint_run_id: 'run-1', sprint_sequence: 0, status: 'RUNNING', created_at: 2 },
      { id: 'sequence-1', sprint_run_id: 'run-1', sprint_sequence: 1, status: 'QUEUED', created_at: 3 },
    ]
    expect(claimableFixtureJobs(mixedJobs).map(({ id }) => id)).toEqual(['legacy'])
  })

  it.each(['FAILED', 'CANCELLED'] as const)(
    'laat de volgende sequence vrij na een %s eerdere sibling',
    async (terminalStatus) => {
      await tryClaimJob('user-1', 'token-1', 'instance-1')

      const sql = claimSql()
      expect(sql).toContain("earlier.status IN ('QUEUED','CLAIMED','RUNNING')")
      expect(sql).not.toMatch(/earlier\.status IN \([^)]*(?:FAILED|CANCELLED|DONE|SKIPPED)/)

      const jobs: FixtureJob[] = [
        { id: 'sequence-0', sprint_run_id: 'run-1', sprint_sequence: 0, status: terminalStatus, created_at: 1 },
        { id: 'sequence-1', sprint_run_id: 'run-1', sprint_sequence: 1, status: 'QUEUED', created_at: 2 },
      ]
      expect(claimableFixtureJobs(jobs).map(({ id }) => id)).toEqual(['sequence-1'])
    },
  )
})
