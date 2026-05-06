import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'

const exec = promisify(execFile)

export async function createPullRequest(opts: {
  worktreePath: string
  branchName: string
  title: string
  body: string
}): Promise<{ url: string } | { error: string }> {
  const { worktreePath, branchName, title, body } = opts

  let url: string
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'create', '--title', title, '--body', body, '--head', branchName],
      { cwd: worktreePath },
    )
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

  // Best-effort: enable auto-merge (squash) on the freshly created PR. If the
  // repo doesn't have "Allow auto-merge" turned on, or the token lacks scope,
  // gh exits non-zero and we just log. The PR is still valid; auto-merge can
  // be turned on manually. We do NOT fail the whole createPullRequest call —
  // the URL was successfully obtained which is the contract this returns.
  try {
    await exec('gh', ['pr', 'merge', '--auto', '--squash', url], { cwd: worktreePath })
  } catch (err) {
    const stderr =
      (err as { stderr?: string }).stderr ?? (err as Error).message ?? ''
    console.warn(
      `[createPullRequest] auto-merge enable failed for ${url}: ${stderr.slice(0, 200)}`,
    )
  }

  return { url }
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

  const worktreeDir =
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR ?? path.join(os.homedir(), '.scrum4me-agent-worktrees')
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
