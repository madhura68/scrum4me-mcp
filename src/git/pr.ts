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

  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'create', '--title', title, '--body', body, '--head', branchName],
      { cwd: worktreePath },
    )
    // gh prints the PR URL as the last non-empty line
    const lines = stdout.trim().split('\n').filter(Boolean)
    const url = lines[lines.length - 1]?.trim() ?? ''
    if (!url.startsWith('http')) {
      return { error: `gh pr create produced unexpected output: ${stdout.slice(0, 200)}` }
    }
    return { url }
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
}
