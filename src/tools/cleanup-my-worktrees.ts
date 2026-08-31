import { z } from 'zod'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { removeWorktreeForJob } from '../git/worktree.js'
import { maybeBackupPush } from '../git/branch-safety.js'
import { getWorktreeRoot, SYSTEM_WORKTREE_DIRS } from '../git/worktree-paths.js'
import { resolveRepoRoot } from './wait-for-job.js'

const TERMINAL_STATUSES = new Set(['DONE', 'FAILED', 'CANCELLED'])
const ACTIVE_STATUSES = new Set(['QUEUED', 'CLAIMED', 'RUNNING'])

const inputSchema = z.object({})

export async function getWorktreeParent(): Promise<string> {
  return getWorktreeRoot()
}

export async function listWorktreeJobIds(worktreeParent: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(worktreeParent, { withFileTypes: true })
    return entries
      .filter(
        (e) =>
          e.isDirectory()
          && !SYSTEM_WORKTREE_DIRS.has(e.name)
          && !e.name.endsWith('.lock'),
      )
      .map((e) => e.name)
  } catch {
    return []
  }
}

export async function cleanupWorktrees(
  worktreeParent: string,
  userId: string,
): Promise<{ removed: string[]; kept: string[]; skipped: string[] }> {
  const jobIds = await listWorktreeJobIds(worktreeParent)
  const removed: string[] = []
  const kept: string[] = []
  const skipped: string[] = []

  if (jobIds.length === 0) return { removed, kept, skipped }

  const jobs = await prisma.claudeJob.findMany({
    where: { id: { in: jobIds }, user_id: userId },
    select: {
      id: true,
      status: true,
      product_id: true,
      branch: true,
      task: { select: { repo_url: true } },
    },
  })
  const jobMap = new Map(jobs.map((j) => [j.id, j]))

  for (const jobId of jobIds) {
    const job = jobMap.get(jobId)

    // No DB record for this jobId — orphan worktree, skip safely
    if (!job) {
      skipped.push(jobId)
      continue
    }

    if (ACTIVE_STATUSES.has(job.status)) {
      kept.push(jobId)
      continue
    }

    if (TERMINAL_STATUSES.has(job.status)) {
      // M38: repo per job resolven — een cross-repo-task (task.repo_url) leeft
      // niet in de product-repo.
      const repoRoot = await resolveRepoRoot(job.product_id, job.task?.repo_url ?? null)
      if (!repoRoot) {
        skipped.push(jobId)
        continue
      }

      // Spec §3.2.4: push vóór verwijdering wanneer origin de tip mist.
      // DONE-jobs hebben hun push al op het done-pad gehad.
      if (job.branch && job.status !== 'DONE') {
        try {
          await maybeBackupPush({
            worktreePath: path.join(worktreeParent, jobId),
            branchName: job.branch,
            context: `cleanup-my-worktrees:${jobId}`,
          })
        } catch {
          // best-effort — nooit de cleanup blokkeren
        }
      }

      // Keep branch for DONE jobs that already pushed (job.branch is set)
      const keepBranch = job.status === 'DONE' && job.branch !== null
      try {
        await removeWorktreeForJob({ repoRoot, jobId, keepBranch })
        removed.push(jobId)
      } catch {
        skipped.push(jobId)
      }
    }
  }

  return { removed, kept, skipped }
}

export function registerCleanupMyWorktreesTool(server: McpServer) {
  server.registerTool(
    'cleanup_my_worktrees',
    {
      title: 'Cleanup my worktrees',
      description:
        'Remove stale git worktrees left by crashed or cancelled agent runs. ' +
        'Scans ~/.scrum4me-agent-worktrees/ (or SCRUM4ME_AGENT_WORKTREE_DIR) for job directories, ' +
        'looks up each job\'s status, and removes worktrees whose jobs are in a terminal state ' +
        '(DONE, FAILED, CANCELLED). Worktrees for active jobs (QUEUED, CLAIMED, RUNNING) are kept. ' +
        'Returns { removed, kept, skipped } for inspection.',
      inputSchema,
      annotations: { readOnlyHint: false },
    },
    async () =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        const worktreeParent = await getWorktreeParent()
        const result = await cleanupWorktrees(worktreeParent, auth.userId)
        return toolJson(result)
      }),
  )
}
