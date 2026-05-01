import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'

const exec = promisify(execFile)

async function branchExists(repoRoot: string, name: string): Promise<boolean> {
  try {
    await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

export async function createWorktreeForJob(opts: {
  repoRoot: string
  jobId: string
  branchName: string
  baseRef?: string
}): Promise<{ worktreePath: string; branchName: string }> {
  const { repoRoot, jobId, baseRef = 'origin/main' } = opts
  let { branchName } = opts

  const parent =
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR ??
    path.join(os.homedir(), '.scrum4me-agent-worktrees')

  await fs.mkdir(parent, { recursive: true })

  const worktreePath = path.join(parent, jobId)

  // Reject if worktree path already exists — caller must remove it first
  try {
    await fs.access(worktreePath)
    throw new Error(
      `Worktree path already exists: ${worktreePath}. Call removeWorktreeForJob first.`,
    )
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await exec('git', ['fetch', 'origin', '--prune'], { cwd: repoRoot })

  // Suffix with timestamp when branch already exists
  if (await branchExists(repoRoot, branchName)) {
    branchName = `${branchName}-${Date.now()}`
  }

  await exec('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], {
    cwd: repoRoot,
  })

  return { worktreePath, branchName }
}
