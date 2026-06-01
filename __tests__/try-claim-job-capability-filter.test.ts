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
    expect(text).toMatch(/w\.capability\s*>/i)
    expect(text).toMatch(/k\.status IN \('CLAIMED','RUNNING'\)/i)
  })

  it('omits clause when capability is null', async () => {
    await tryClaimJob('u1', 't1', 'i1', undefined, 'CLAUDE', [], null)
    const fragments = queryRawMock.mock.calls[0]
      .flat()
      .filter((v): v is { strings: string[] } => v && typeof v === 'object' && 'strings' in v)
    const text = fragments.flatMap((f) => f.strings).join(' ')
    expect(text).not.toMatch(/w\.capability\s*>/i)
  })
})
