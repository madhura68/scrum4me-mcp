import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const GIT_DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024

export async function getGitDiff(worktreePath: string, range: string): Promise<string> {
  const { stdout } = await exec('git', ['diff', range], {
    cwd: worktreePath,
    maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
  })
  return stdout
}
