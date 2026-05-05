import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
