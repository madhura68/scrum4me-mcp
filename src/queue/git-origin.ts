// Best-effort repo derivation for queue_push (spec §5.1): `git remote get-url
// origin` in the caller-supplied cwd. Every failure mode (no repo, no origin,
// missing dir, timeout) returns null — the tool then requires explicit
// meta.task.repo. Separate module so tool tests can vi.mock it.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function deriveRepoFromCwd(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5_000 })
    const url = stdout.trim()
    return url.length > 0 ? url : null
  } catch {
    return null
  }
}
