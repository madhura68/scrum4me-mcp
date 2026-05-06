import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import { getWorktreeRoot } from './worktree-paths.js'

const exec = promisify(execFile)

export async function createPullRequest(opts: {
  worktreePath: string
  branchName: string
  title: string
  body: string
  /** Open as draft PR (mens moet 'm later ready-for-review zetten). Default false. */
  draft?: boolean
  /**
   * PBI-47 (P0): default changed to false. Auto-merge is now enabled
   * separately via `enableAutoMergeOnPr` only on the **last task** of a
   * STORY-mode story, with a head-SHA guard to prevent racing earlier
   * task merges. Callers may still pass `true` for one-off PRs that
   * are immediately ready to merge; in that case we use the new typed
   * helper rather than the previous fire-and-forget gh call.
   */
  enableAutoMerge?: boolean
}): Promise<{ url: string } | { error: string }> {
  const { worktreePath, branchName, title, body, draft = false, enableAutoMerge = false } = opts

  let url: string
  try {
    const args = ['pr', 'create', '--title', title, '--body', body, '--head', branchName]
    if (draft) args.push('--draft')
    const { stdout } = await exec('gh', args, { cwd: worktreePath })
    // gh prints the PR URL as the last non-empty line
    const lines = stdout.trim().split('\n').filter(Boolean)
    url = lines[lines.length - 1]?.trim() ?? ''
    if (!url.startsWith('http')) {
      return { error: `gh pr create produced unexpected output: ${stdout.slice(0, 200)}` }
    }
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? String(err)
    const isNotFound =
      msg.includes('command not found') ||
      msg.includes('is not recognized') ||
      msg.includes('ENOENT')
    if (isNotFound) {
      return { error: 'gh CLI not found — install GitHub CLI to enable auto-PR' }
    }
    return { error: `gh pr create failed: ${msg.slice(0, 300)}` }
  }

  // Legacy opt-in: enableAutoMerge=true and not draft → fire the new typed
  // helper without head-SHA guard (caller didn't supply one). Result is
  // logged but not propagated — same shape as before.
  if (enableAutoMerge && !draft) {
    const result = await enableAutoMergeOnPr({ prUrl: url, cwd: worktreePath })
    if (!result.ok) {
      console.warn(
        `[createPullRequest] auto-merge enable failed for ${url}: ${result.reason} ${result.stderr.slice(0, 200)}`,
      )
    }
  }

  return { url }
}

export type AutoMergeFailReason =
  | 'CHECKS_FAILED'
  | 'MERGE_CONFLICT'
  | 'GH_AUTH_ERROR'
  | 'AUTO_MERGE_NOT_ALLOWED'
  | 'UNKNOWN'

export type EnableAutoMergeResult =
  | { ok: true }
  | { ok: false; reason: AutoMergeFailReason; stderr: string }

function classifyAutoMergeError(stderr: string): AutoMergeFailReason {
  if (/conflict|not in mergeable state|dirty/i.test(stderr)) return 'MERGE_CONFLICT'
  if (/checks? failed|status check|required check/i.test(stderr)) return 'CHECKS_FAILED'
  if (/authentication|HTTP 401|HTTP 403|permission|gh auth/i.test(stderr)) return 'GH_AUTH_ERROR'
  if (/auto-?merge.*not.*allowed|auto-?merge.*disabled/i.test(stderr)) return 'AUTO_MERGE_NOT_ALLOWED'
  return 'UNKNOWN'
}

/**
 * Enable auto-merge (squash) on a PR with an optional head-SHA guard.
 *
 * PBI-47 (P0): when `expectedHeadSha` is provided we pass `--match-head-commit`
 * so GitHub only activates auto-merge if the remote head still matches the
 * SHA the caller observed. This prevents racing late pushes from another
 * worker triggering a merge of a different commit set.
 */
export async function enableAutoMergeOnPr(opts: {
  prUrl: string
  expectedHeadSha?: string
  cwd?: string
}): Promise<EnableAutoMergeResult> {
  try {
    const args = ['pr', 'merge', '--auto', '--squash']
    if (opts.expectedHeadSha) args.push('--match-head-commit', opts.expectedHeadSha)
    args.push(opts.prUrl)
    await exec('gh', args, opts.cwd ? { cwd: opts.cwd } : {})
    return { ok: true }
  } catch (err) {
    const stderr =
      (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    return { ok: false, reason: classifyAutoMergeError(stderr), stderr: stderr.slice(0, 500) }
  }
}

// Zet een draft-PR over naar "ready for review". Gebruikt bij sprint-mode
// wanneer alle stories in de SprintRun DONE zijn — mens reviewt en mergt zelf.
export async function markPullRequestReady(opts: {
  prUrl: string
  cwd?: string
}): Promise<{ ok: true } | { error: string }> {
  try {
    await exec('gh', ['pr', 'ready', opts.prUrl], opts.cwd ? { cwd: opts.cwd } : {})
    return { ok: true }
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    // gh-CLI fout "Pull request is not in draft state" is benign wanneer de
    // PR al ready was (bv. handmatig ready gezet of een tweede call).
    if (/not in draft state|already in ready/i.test(msg)) return { ok: true }
    return { error: `gh pr ready failed: ${msg.slice(0, 300)}` }
  }
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export type PrInfo = {
  state: PrState
  mergeCommit: string | null
  baseRefName: string
  title: string
}

export async function getPullRequestState(opts: {
  prUrl: string
  cwd?: string
}): Promise<PrInfo | { error: string }> {
  const { prUrl } = opts
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'view', prUrl, '--json', 'state,mergeCommit,baseRefName,title'],
      opts.cwd ? { cwd: opts.cwd } : {},
    )
    const parsed = JSON.parse(stdout) as {
      state: string
      mergeCommit: { oid: string } | null
      baseRefName: string
      title: string
    }
    const state = parsed.state.toUpperCase() as PrState
    if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') {
      return { error: `unexpected PR state: ${parsed.state}` }
    }
    return {
      state,
      mergeCommit: parsed.mergeCommit?.oid ?? null,
      baseRefName: parsed.baseRefName,
      title: parsed.title,
    }
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    return { error: `gh pr view failed: ${msg.slice(0, 300)}` }
  }
}

export async function closePullRequest(opts: {
  prUrl: string
  comment: string
  cwd?: string
}): Promise<{ ok: true } | { error: string }> {
  try {
    await exec(
      'gh',
      ['pr', 'close', opts.prUrl, '--delete-branch', '--comment', opts.comment],
      opts.cwd ? { cwd: opts.cwd } : {},
    )
    return { ok: true }
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    return { error: `gh pr close failed: ${msg.slice(0, 300)}` }
  }
}

// Creates a revert-PR for a merged PR. Uses an isolated worktree so it
// never touches the user's main checkout. Returns the new PR URL or an
// error string. The revert PR is opened WITHOUT auto-merge — the user
// must review + merge it manually so an unintended cascade can be undone.
export async function createRevertPullRequest(opts: {
  repoRoot: string
  mergeSha: string
  baseRef: string
  originalTitle: string
  originalBranch: string
  jobId: string
  pbiCode: string | null
}): Promise<{ url: string } | { error: string }> {
  const {
    repoRoot,
    mergeSha,
    baseRef,
    originalTitle,
    originalBranch,
    jobId,
    pbiCode,
  } = opts

  const worktreeDir = getWorktreeRoot()
  const wtPath = path.join(worktreeDir, `revert-${jobId}`)
  const revertBranch = `revert/${originalBranch}-${jobId.slice(-8)}`

  const run = async (cmd: string, args: string[], cwd: string) => {
    await exec(cmd, args, { cwd })
  }

  // Cleanup helper, best-effort
  const cleanup = async () => {
    try {
      await exec('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot })
    } catch {
      // ignore — worktree may not exist if creation failed
    }
  }

  try {
    await run('git', ['fetch', 'origin', baseRef, mergeSha], repoRoot)
    await run('git', ['worktree', 'add', '-b', revertBranch, wtPath, `origin/${baseRef}`], repoRoot)

    try {
      await run('git', ['revert', '-m', '1', mergeSha, '--no-edit'], wtPath)
    } catch (err) {
      await cleanup()
      const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
      if (/conflict/i.test(msg)) {
        return { error: `git revert conflicts on ${mergeSha}: ${msg.slice(0, 200)}` }
      }
      return { error: `git revert failed: ${msg.slice(0, 200)}` }
    }

    await run('git', ['push', '-u', 'origin', revertBranch], wtPath)

    const pbiTag = pbiCode ? `PBI ${pbiCode}` : 'PBI'
    const title = `Revert: ${originalTitle}`
    const body = [
      `Auto-revert by Scrum4Me agent.`,
      ``,
      `Reason: ${pbiTag} failed (cascade from job \`${jobId}\`).`,
      `Reverts merge commit \`${mergeSha}\`.`,
      ``,
      `**Review carefully before merging** — auto-merge is intentionally NOT enabled on revert PRs.`,
    ].join('\n')

    let prUrl: string
    try {
      const { stdout } = await exec(
        'gh',
        [
          'pr',
          'create',
          '--base',
          baseRef,
          '--head',
          revertBranch,
          '--title',
          title,
          '--body',
          body,
        ],
        { cwd: wtPath },
      )
      const lines = stdout.trim().split('\n').filter(Boolean)
      prUrl = lines[lines.length - 1]?.trim() ?? ''
      if (!prUrl.startsWith('http')) {
        await cleanup()
        return { error: `gh pr create produced unexpected output: ${stdout.slice(0, 200)}` }
      }
    } catch (err) {
      await cleanup()
      const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
      return { error: `gh pr create (revert) failed: ${msg.slice(0, 300)}` }
    }

    await cleanup()
    return { url: prUrl }
  } catch (err) {
    await cleanup()
    const msg = (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    return { error: `revert worktree setup failed: ${msg.slice(0, 300)}` }
  }
}
