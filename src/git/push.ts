import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

type PushSuccess = { pushed: true; remoteRef: string }
type PushFailure = {
  pushed: false
  reason: 'no-credentials' | 'conflict' | 'no-changes' | 'unknown'
  stderr: string
}

export type PushResult = PushSuccess | PushFailure

export async function pushBranchForJob(opts: {
  worktreePath: string
  branchName: string
}): Promise<PushResult> {
  const { worktreePath, branchName } = opts

  // Detect no new commits vs origin/main
  let headSha: string
  let baseSha: string
  try {
    const [headResult, baseResult] = await Promise.all([
      exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath }),
      exec('git', ['rev-parse', 'origin/main'], { cwd: worktreePath }),
    ])
    headSha = headResult.stdout.trim()
    baseSha = baseResult.stdout.trim()
  } catch (err) {
    return { pushed: false, reason: 'unknown', stderr: (err as Error).message }
  }

  if (headSha === baseSha) {
    return { pushed: false, reason: 'no-changes', stderr: '' }
  }

  // Push
  try {
    await exec('git', ['push', '-u', 'origin', branchName], { cwd: worktreePath })
    return { pushed: true, remoteRef: `refs/heads/${branchName}` }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    if (/Authentication failed|could not read Username/i.test(stderr)) {
      return { pushed: false, reason: 'no-credentials', stderr }
    }
    if (/non-fast-forward|already exists on the remote|rejected/i.test(stderr)) {
      return { pushed: false, reason: 'conflict', stderr }
    }
    return { pushed: false, reason: 'unknown', stderr }
  }
}
