// IDEA-243: notify-gedrag van de gewone (Prisma-)route die niet al in een bestaande
// testfile is vastgepind: markJobTerminallyFailed, rollbackClaim, DOCS_AUDIT-terminaal
// en de usage-hook.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const locks = vi.hoisted(() => ({ releaseLocksOnTerminal: vi.fn() }))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    $executeRaw: vi.fn(),
    claudeJob: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    sprintRun: { update: vi.fn() },
    sprintTaskExecution: { deleteMany: vi.fn() },
    product: { findUnique: vi.fn() },
  },
}))
vi.mock('../src/git/job-locks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/job-locks.js')>()),
  releaseLocksOnTerminal: locks.releaseLocksOnTerminal,
}))
vi.mock('../src/git/worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/worktree.js')>()),
  removeWorktreeForJob: vi.fn(),
}))
vi.mock('../src/git/branch-safety.js', () => ({ maybeBackupPush: vi.fn().mockResolvedValue('pushed') }))

import { prisma } from '../src/prisma.js'
import { markJobTerminallyFailed, rollbackClaim } from '../src/tools/wait-for-job.js'
import { applyDocsAuditTerminalUpdate } from '../src/tools/update-job-status.js'
import { persistJobUsageSnapshot } from '../src/lib/job-usage/persist.js'
import type { JobUsageSnapshot } from '../src/lib/job-usage/types.js'

const mp = prisma as unknown as {
  $executeRaw: ReturnType<typeof vi.fn>
  claudeJob: Record<'findFirst' | 'findUnique' | 'update' | 'updateMany', ReturnType<typeof vi.fn>>
  sprintRun: { update: ReturnType<typeof vi.fn> }
  sprintTaskExecution: { deleteMany: ReturnType<typeof vi.fn> }
}

const ROW = (status: string) => ({
  id: 'job-1', user_id: 'user-1', product_id: 'prod-1', kind: 'TASK_IMPLEMENTATION', status,
})
const notified = () => mp.$executeRaw.mock.calls
  .filter(([strings]) => (strings as readonly string[]).join('?').includes('pg_notify'))
  .map(([, , payload]) => JSON.parse(payload as string))

beforeEach(() => {
  vi.clearAllMocks()
  mp.$executeRaw.mockResolvedValue(1)
  mp.claudeJob.update.mockResolvedValue({})
  mp.claudeJob.findFirst.mockResolvedValue(null)
  mp.sprintRun.update.mockResolvedValue({})
  mp.sprintTaskExecution.deleteMany.mockResolvedValue({ count: 0 })
  locks.releaseLocksOnTerminal.mockResolvedValue(undefined)
})

describe('markJobTerminallyFailed', () => {
  const lookup = { kind: 'SPRINT_IMPLEMENTATION', sprint_run_id: 'run-1', dispatch_request_id: null, dispatch_candidate_id: null, task_executions: [], task: null }

  it('notificeert FAILED nadat locks zijn vrijgegeven en de SprintRun FAILED is', async () => {
    mp.claudeJob.findUnique.mockResolvedValueOnce(lookup).mockResolvedValueOnce(ROW('FAILED'))
    const order: string[] = []
    locks.releaseLocksOnTerminal.mockImplementation(async () => { order.push('locks') })
    mp.sprintRun.update.mockImplementation(async () => { order.push('sprintrun') })
    mp.$executeRaw.mockImplementation(async () => { order.push('notify'); return 1 })

    await markJobTerminallyFailed('job-1', 'kapot')

    expect(order).toEqual(['locks', 'sprintrun', 'notify'])
    expect(notified()).toEqual([expect.objectContaining({ type: 'claude_job_status_changed', job_id: 'job-1', status: 'FAILED' })])
  })

  it('een gooiende notify laat de locks vrijgegeven en de SprintRun FAILED, en rethrowt niet', async () => {
    mp.claudeJob.findUnique.mockResolvedValueOnce(lookup).mockResolvedValueOnce(ROW('FAILED'))
    mp.$executeRaw.mockRejectedValue(new Error('notify kapot'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(markJobTerminallyFailed('job-1', 'kapot')).resolves.toBeUndefined()

    expect(locks.releaseLocksOnTerminal).toHaveBeenCalledWith('job-1')
    expect(mp.sprintRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('rollbackClaim — notify alleen als de job echt terug is naar QUEUED', () => {
  const lookup = { kind: 'TASK_IMPLEMENTATION', product_id: null, branch: null, task: null, dispatch_request_id: null, dispatch_candidate_id: null, task_executions: [] }

  it('requeued = 0: geen notify', async () => {
    mp.claudeJob.findUnique.mockResolvedValue(lookup)
    mp.$executeRaw.mockResolvedValue(0)

    await rollbackClaim('job-1', { tokenId: 't', instanceId: 'i' })

    expect(notified()).toEqual([])
  })

  it('requeued > 0: één notify met de actuele rij', async () => {
    mp.claudeJob.findUnique.mockResolvedValueOnce(lookup).mockResolvedValue(ROW('QUEUED'))
    mp.$executeRaw.mockResolvedValue(1)

    await rollbackClaim('job-1', { tokenId: 't', instanceId: 'i' })

    expect(notified()).toEqual([expect.objectContaining({ job_id: 'job-1', status: 'QUEUED' })])
  })
})

describe('applyDocsAuditTerminalUpdate', () => {
  const input = { jobId: 'job-1', callerTokenId: 'tok', status: 'done' as const, source: 'SYSTEM', summary: 's', skipReason: null, processedUntil: null, capped: false }

  it('stuurt een notify na een geslaagde terminale update', async () => {
    mp.claudeJob.updateMany.mockResolvedValue({ count: 1 })
    mp.claudeJob.findUnique.mockResolvedValue({ ...ROW('DONE'), kind: 'DOCS_AUDIT' })

    const res = await applyDocsAuditTerminalUpdate(input)

    expect(res).toEqual({ ok: true, status: 'DONE' })
    expect(notified()).toEqual([expect.objectContaining({ job_id: 'job-1', kind: 'DOCS_AUDIT', status: 'DONE' })])
  })

  it('stuurt niets bij de zero-count-guard', async () => {
    mp.claudeJob.updateMany.mockResolvedValue({ count: 0 })

    const res = await applyDocsAuditTerminalUpdate(input)

    expect(res.ok).toBe(false)
    expect(mp.$executeRaw).not.toHaveBeenCalled()
  })
})

describe('persistJobUsageSnapshot', () => {
  const snapshot: JobUsageSnapshot = {
    runtime: 'CLAUDE', modelId: 'm', pricingModelId: 'm', pricingModelSource: 'pricing_default',
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningOutputTokens: 0,
    captureSource: 'claude_post_tool_use', captureStatus: 'captured',
  }
  const guard = { ownerGuard: { claimedByTokenId: 't', workerInstanceId: 'w' } }

  it('notificeert op de bewaakte tak na een geslaagde write', async () => {
    mp.claudeJob.updateMany.mockResolvedValue({ count: 1 })
    mp.claudeJob.findUnique.mockResolvedValue(ROW('DONE'))
    expect(await persistJobUsageSnapshot('job-1', snapshot, guard)).toBe('written')
    expect(notified()).toHaveLength(1)
  })

  it('notificeert op de onbewaakte tak', async () => {
    mp.claudeJob.update.mockResolvedValue({})
    mp.claudeJob.findUnique.mockResolvedValue(ROW('DONE'))
    expect(await persistJobUsageSnapshot('job-1', snapshot)).toBe('written')
    expect(notified()).toHaveLength(1)
  })

  it('notificeert niet bij een mislukte guard', async () => {
    mp.claudeJob.updateMany.mockResolvedValue({ count: 0 })
    expect(await persistJobUsageSnapshot('job-1', snapshot, guard)).toBe('guard_mismatch')
    expect(mp.$executeRaw).not.toHaveBeenCalled()
  })

  it('gooit niet door als de notify faalt (de hook blokkeert nooit)', async () => {
    mp.claudeJob.updateMany.mockResolvedValue({ count: 1 })
    mp.claudeJob.findUnique.mockResolvedValue(ROW('DONE'))
    mp.$executeRaw.mockRejectedValue(new Error('notify kapot'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(persistJobUsageSnapshot('job-1', snapshot, guard)).resolves.toBe('written')
    warn.mockRestore()
  })
})
