// Laag-3-primitieven (spec 2026-08-30-sprint-job-werkbackup-design.md §3.3):
// vernietiging alleen als origin de tip aantoonbaar heeft, pushes best-effort
// en ff-only, faalrichting van elke check is "bewaren".

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pushBranchForJob } from './push.js'
import { claimLog } from '../lib/claim-log.js'

const exec = promisify(execFile)

export async function resolveWorktreeHead(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
    return stdout.trim()
  } catch {
    return null
  }
}

// Best-effort taakgrens-/vangnet-push. Skip wanneer HEAD al gelijk is aan de
// lokale tracking-ref van origin/<branch> — goedkope pre-check; is die ref
// stale, dan is de fallback een onschadelijke up-to-date-push (exit 0).
// NB: pushBranchForJob's eigen 'no-changes' betekent HEAD == origin/main en
// is hier dus GEEN skip-signaal (spec §4-invariant).
export async function maybeBackupPush(opts: {
  worktreePath: string
  branchName: string
  context: string
}): Promise<'pushed' | 'up-to-date' | 'skipped'> {
  const { worktreePath, branchName, context } = opts
  try {
    const head = await resolveWorktreeHead(worktreePath)
    if (!head) {
      claimLog('backup-push.skip_no_worktree', { context, branchName, worktreePath })
      return 'skipped'
    }
    try {
      const { stdout } = await exec(
        'git',
        ['rev-parse', `refs/remotes/origin/${branchName}`],
        { cwd: worktreePath },
      )
      if (stdout.trim() === head) return 'up-to-date'
    } catch {
      // geen tracking-ref — gewoon pushen
    }
    const result = await pushBranchForJob({ worktreePath, branchName })
    if (result.pushed) {
      claimLog('backup-push.pushed', { context, branchName })
      return 'pushed'
    }
    // no-changes (HEAD==origin/main), no-credentials, conflict, unknown:
    // allemaal best-effort accepteren.
    claimLog('backup-push.not_pushed', { context, branchName, reason: result.reason })
    return 'skipped'
  } catch (err) {
    console.warn(`[backup-push] ${context} failed for ${branchName}:`, err)
    return 'skipped'
  }
}

// Branch-ref-variant: voor paden waar <branch> niet is uitgecheckt (bv. de
// reuse-preconditie in createWorktreeForJob, met repoRoot op main). Vergelijkt
// en pusht op refs/heads/<branch>-niveau; cwd-HEAD speelt geen rol. Bewust
// niet via pushBranchForJob — diens no-changes betekent cwd-HEAD ==
// origin/main en zou hier de push onterecht overslaan.
export async function maybeBackupPushBranch(opts: {
  repoRoot: string
  branchName: string
  context: string
}): Promise<'pushed' | 'up-to-date' | 'skipped'> {
  const { repoRoot, branchName, context } = opts
  try {
    let tip: string
    try {
      const { stdout } = await exec(
        'git',
        ['rev-parse', `refs/heads/${branchName}`],
        { cwd: repoRoot },
      )
      tip = stdout.trim()
    } catch {
      claimLog('backup-push.skip_no_local_branch', { context, branchName })
      return 'skipped'
    }
    try {
      const { stdout } = await exec(
        'git',
        ['rev-parse', `refs/remotes/origin/${branchName}`],
        { cwd: repoRoot },
      )
      if (stdout.trim() === tip) return 'up-to-date'
    } catch {
      // geen tracking-ref — gewoon pushen
    }
    await exec(
      'git',
      ['push', 'origin', `refs/heads/${branchName}:refs/heads/${branchName}`],
      { cwd: repoRoot },
    )
    claimLog('backup-push.pushed', { context, branchName })
    return 'pushed'
  } catch (err) {
    console.warn(`[backup-push] ${context} failed for ${branchName}:`, err)
    return 'skipped'
  }
}

// Waarheidsbron: ls-remote (spec §3.3) — nooit alleen de lokale tracking-ref.
export async function localTipContainedInRemote(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  try {
    const { stdout: localOut } = await exec(
      'git',
      ['rev-parse', `refs/heads/${branchName}`],
      { cwd: repoRoot },
    )
    const localTip = localOut.trim()
    const { stdout: remoteOut } = await exec(
      'git',
      ['ls-remote', 'origin', `refs/heads/${branchName}`],
      { cwd: repoRoot },
    )
    const remoteSha = remoteOut.trim().split(/\s+/)[0]
    if (!remoteSha) return false
    if (remoteSha === localTip) return true
    await exec('git', ['merge-base', '--is-ancestor', localTip, remoteSha], { cwd: repoRoot })
    return true
  } catch {
    return false // faalrichting = bewaren
  }
}

export async function remoteTipMergedIntoMain(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  try {
    const { stdout: remoteOut } = await exec(
      'git',
      ['ls-remote', 'origin', `refs/heads/${branchName}`],
      { cwd: repoRoot },
    )
    const remoteSha = remoteOut.trim().split(/\s+/)[0]
    if (!remoteSha) return false
    await exec('git', ['merge-base', '--is-ancestor', remoteSha, 'origin/main'], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}
