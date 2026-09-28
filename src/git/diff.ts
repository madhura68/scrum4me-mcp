import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitPrefixFor } from './local-llm.js'

const exec = promisify(execFile)

export const GIT_DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024

export async function getGitDiff(worktreePath: string, range: string): Promise<string> {
  const prefix = await gitPrefixFor(worktreePath)
  const { stdout } = await exec('git', [...prefix, 'diff', range], {
    cwd: worktreePath,
    maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
  })
  return stdout
}
