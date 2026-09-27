import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'

vi.mock('../src/git/push.js', () => ({
  pushBranchForJob: vi.fn(),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('../src/git/branch-safety.js', () => ({
  maybeBackupPush: vi.fn(),
}))

// Taak 4: prepareDoneUpdate doet ná een geslaagde push een directe
// `rev-parse HEAD` via een dynamische node:child_process-import, die nu
// gitPrefixFor(worktreePath) meekrijgt. Mock execFile met de last-arg-
// callback-conventie (zoals __tests__/git/push.test.ts) zodat we de exacte
// argumenten kunnen asserten zonder een echte worktree op schijf nodig te
// hebben.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { pushBranchForJob } from '../src/git/push.js'
import { prisma } from '../src/prisma.js'
import { maybeBackupPush } from '../src/git/branch-safety.js'
import { execFile } from 'node:child_process'
import { SAFE_GIT_CONFIG } from '../src/git/local-llm.js'
import { backupPushOnFailure, prepareDoneUpdate } from '../src/tools/update-job-status.js'

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void

const mockPush = pushBranchForJob as ReturnType<typeof vi.fn>
const mockBackupPush = maybeBackupPush as unknown as ReturnType<typeof vi.fn>
const mockFindUnique = (prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
}).claudeJob.findUnique
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockFindUnique.mockResolvedValue(null)
  mockBackupPush.mockResolvedValue('pushed')
  // Default: gedraagt zich als het reële path-gebaseerde gedrag van vóór
  // deze mock — de post-push rev-parse faalt stil tegen een niet-bestaande
  // worktree (headSha blijft undefined, alleen console.warn). Individuele
  // tests zetten desgewenst een succesvolle implementatie.
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
    cb(new Error('ENOENT: test default (no real worktree on disk)')),
  )
})

describe('prepareDoneUpdate', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv.SCRUM4ME_AGENT_WORKTREE_DIR
  })

  it('returns DONE with pushedAt and branchOverride when push succeeds', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/job-abc' })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('DONE')
    expect(plan.pushedAt).toBeInstanceOf(Date)
    expect(plan.branchOverride).toBe('feat/job-abc')
    expect(plan.errorOverride).toBeUndefined()
    expect(plan.skipWorktreeCleanup).toBe(false)

    expect(mockPush).toHaveBeenCalledWith({
      worktreePath: path.join('/wt', 'job-abc'),
      branchName: 'feat/job-abc',
    })
  })

  it('reads branchName from DB (claudeJob.branch) when branch arg is undefined', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockFindUnique.mockResolvedValue({ branch: 'feat/sprint-fvy30lvv' })
    mockPush.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/sprint-fvy30lvv' })

    await prepareDoneUpdate('job-abc12345', undefined)

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'job-abc12345' },
      select: { branch: true },
    })
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feat/sprint-fvy30lvv' }),
    )
  })

  it('falls back to feat/job-<8> when neither branch arg nor DB.branch is set', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockFindUnique.mockResolvedValue({ branch: null })
    mockPush.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/job-abc12345' })

    await prepareDoneUpdate('job-abc12345', undefined)

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feat/job-abc12345' }),
    )
  })

  it('returns DONE without pushedAt when no-changes', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({ pushed: false, reason: 'no-changes', stderr: '' })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('DONE')
    expect(plan.pushedAt).toBeUndefined()
    expect(plan.branchOverride).toBeUndefined()
    expect(plan.errorOverride).toBeUndefined()
    expect(plan.skipWorktreeCleanup).toBe(false)
  })

  it('returns FAILED with error and skipWorktreeCleanup when no-credentials', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({
      pushed: false,
      reason: 'no-credentials',
      stderr: 'fatal: Authentication failed',
    })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('FAILED')
    expect(plan.errorOverride).toContain('push failed (no-credentials)')
    expect(plan.errorOverride).toContain('Authentication failed')
    expect(plan.skipWorktreeCleanup).toBe(true)
  })

  it('returns FAILED with error and skipWorktreeCleanup when conflict', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({
      pushed: false,
      reason: 'conflict',
      stderr: '! [rejected] non-fast-forward',
    })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('FAILED')
    expect(plan.errorOverride).toContain('push failed (conflict)')
    expect(plan.skipWorktreeCleanup).toBe(true)
  })

  it('returns FAILED with error and skipWorktreeCleanup when unknown push error', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({
      pushed: false,
      reason: 'unknown',
      stderr: 'something went wrong',
    })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('FAILED')
    expect(plan.skipWorktreeCleanup).toBe(true)
  })

  // Taak 4: de post-push rev-parse HEAD (headSha) krijgt gitPrefixFor(worktreePath).
  it('prefixt de post-push rev-parse HEAD met SAFE_GIT_CONFIG voor een local_llm-job', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/job-abc' })
    mockFindUnique.mockResolvedValue({ required_capability: 'local_llm' })
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
      cb(null, { stdout: 'deadbeef\n', stderr: '' }),
    )

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.headSha).toBe('deadbeef')
    const revParseCall = mockExecFile.mock.calls.find((c) => {
      const args = c[1] as string[]
      return Array.isArray(args) && args.includes('rev-parse') && args.includes('HEAD')
    })
    expect(revParseCall).toBeDefined()
    expect(revParseCall![1]).toEqual([...SAFE_GIT_CONFIG, 'rev-parse', 'HEAD'])
  })

  it('laat de post-push rev-parse HEAD ongewijzigd voor een niet-lokale job', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/job-abc' })
    mockFindUnique.mockResolvedValue(null)
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
      cb(null, { stdout: 'deadbeef\n', stderr: '' }),
    )

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.headSha).toBe('deadbeef')
    const revParseCall = mockExecFile.mock.calls.find((c) => {
      const args = c[1] as string[]
      return Array.isArray(args) && args.includes('rev-parse') && args.includes('HEAD')
    })
    expect(revParseCall).toBeDefined()
    expect(revParseCall![1]).toEqual(['rev-parse', 'HEAD'])
  })
})

// M38 T4 — spec §3.2.1: vangnet-push op het failed-pad
describe('backupPushOnFailure', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv.SCRUM4ME_AGENT_WORKTREE_DIR
  })

  it('pusht de jobbranch vanaf het worktree-pad', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    await backupPushOnFailure('job-1', 'feat/sprint-x')
    expect(mockBackupPush).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: path.join('/wt', 'job-1'),
        branchName: 'feat/sprint-x',
      }),
    )
  })

  it('is een no-op zonder branch', async () => {
    await backupPushOnFailure('job-1', null)
    expect(mockBackupPush).not.toHaveBeenCalled()
  })

  it('slikt fouten', async () => {
    mockBackupPush.mockRejectedValue(new Error('x'))
    await expect(backupPushOnFailure('job-1', 'b')).resolves.toBeUndefined()
  })
})

it('blocks managed failure and done push before invoking external publication',async()=>{
  mockFindUnique.mockResolvedValue({kind:'QUEUE_TASK',dispatch_request_id:'request',dispatch_candidate_id:'candidate'})
  await expect(prepareDoneUpdate('managed','codex/request')).rejects.toThrow('DISPATCH_MANAGED_ROW')
  await expect(backupPushOnFailure('managed','codex/request')).rejects.toThrow('DISPATCH_MANAGED_ROW')
  expect(mockPush).not.toHaveBeenCalled();expect(mockBackupPush).not.toHaveBeenCalled()
})

// ST-1590.37: the cleanup path reads job-level markers of THIS job only. prepareDoneUpdate is not a
// cleanup path — it publishes — so it keeps refusing on the current task binding.
it('still backs up the branch of an ended job whose task went managed afterwards',async()=>{
  mockFindUnique.mockResolvedValue({kind:'TASK_IMPLEMENTATION',dispatch_request_id:null,dispatch_candidate_id:null,task:{dispatch_request_id:'managed-request'},task_executions:[{task:{dispatch_request_id:'managed-request'}}]})
  await expect(backupPushOnFailure('handed-over','feat/old')).resolves.toBeUndefined()
  expect(mockBackupPush).toHaveBeenCalledTimes(1)
  await expect(prepareDoneUpdate('handed-over','feat/old')).rejects.toThrow('DISPATCH_MANAGED_ROW')
})

it('backs up the branch and never throws when the marker read fails',async()=>{
  mockFindUnique.mockRejectedValue(Object.assign(new Error('connection refused'),{name:'PrismaClientInitializationError'}))
  await expect(backupPushOnFailure('db-down','feat/old')).resolves.toBeUndefined()
  expect(mockBackupPush).toHaveBeenCalledTimes(1)
})
