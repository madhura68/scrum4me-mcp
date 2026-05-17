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

export type DeleteRemoteResult =
  | { deleted: true }
  | {
      deleted: false
      reason: 'not-found' | 'no-credentials' | 'head-mismatch' | 'unknown'
      stderr: string
    }

export async function deleteRemoteBranch(opts: {
  repoRoot: string
  branch: string
  /**
   * Optional safety-guard: wanneer gezet vergelijken we eerst `git ls-remote
   * origin refs/heads/<branch>` met `expectedHeadSha`. Bij mismatch wordt de
   * delete geweigerd met reason='head-mismatch' zodat we niet per ongeluk
   * een latere worker-push wegvegen. Wanneer de remote ref niet (meer)
   * bestaat is dat geen mismatch — we vallen door naar de normale delete-
   * pad die 'not-found' returnt.
   */
  expectedHeadSha?: string
}): Promise<DeleteRemoteResult> {
  const { repoRoot, branch, expectedHeadSha } = opts

  if (expectedHeadSha) {
    try {
      const { stdout } = await exec(
        'git',
        ['ls-remote', 'origin', `refs/heads/${branch}`],
        { cwd: repoRoot },
      )
      const remoteSha = stdout.trim().split(/\s+/)[0]
      if (remoteSha && remoteSha !== expectedHeadSha) {
        return {
          deleted: false,
          reason: 'head-mismatch',
          stderr: `expected ${expectedHeadSha}, remote at ${remoteSha}`,
        }
      }
      // remoteSha leeg → branch al gone; laat de delete hieronder 'not-found' returnen.
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
      return { deleted: false, reason: 'unknown', stderr }
    }
  }

  try {
    await exec('git', ['push', 'origin', '--delete', branch], { cwd: repoRoot })
    return { deleted: true }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    if (/remote ref does not exist|unable to delete .* remote ref does not exist/i.test(stderr)) {
      return { deleted: false, reason: 'not-found', stderr }
    }
    if (/Authentication failed|could not read Username/i.test(stderr)) {
      return { deleted: false, reason: 'no-credentials', stderr }
    }
    return { deleted: false, reason: 'unknown', stderr }
  }
}
