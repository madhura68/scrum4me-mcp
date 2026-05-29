// Deferred worktree-cleanup queue.
//
// Why this exists: token-usage on claude_jobs is filled by a Claude Code
// PostToolUse hook (scripts/persist-job-usage.ts) that fires after the agent
// calls update_job_status. Claude Code spawns that hook with cwd = the agent's
// worktree. If update_job_status removes the worktree inline (the terminal-status
// cleanup), the hook spawn fails with "posix_spawn '/bin/sh' ENOENT" because its
// cwd no longer exists — so usage is never persisted for jobs that have a per-job
// worktree (SPRINT_IMPLEMENTATION / TASK_IMPLEMENTATION).
//
// Fix: update_job_status records the worktree as "cleanup pending" (a marker file)
// instead of removing it. The worker runner (run-one-job) removes it AFTER the
// agent's Claude process has exited — i.e. after the hook has run — via
// runDeferredWorktreeCleanup() in update-job-status.ts.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getWorktreeRoot } from './worktree-paths.js'

// Co-located with the worktrees, OUTSIDE any individual worktree so it survives
// `git worktree remove`. Excluded from worktree scanning via SYSTEM_WORKTREE_DIRS.
function cleanupQueueDir(): string {
  return path.join(getWorktreeRoot(), '.cleanup-queue')
}

export async function markWorktreeCleanupPending(jobId: string): Promise<void> {
  const dir = cleanupQueueDir()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, jobId), '', 'utf8')
}

export async function isWorktreeCleanupPending(jobId: string): Promise<boolean> {
  try {
    await fs.access(path.join(cleanupQueueDir(), jobId))
    return true
  } catch {
    return false
  }
}

export async function clearWorktreeCleanupPending(jobId: string): Promise<void> {
  await fs.rm(path.join(cleanupQueueDir(), jobId), { force: true })
}
