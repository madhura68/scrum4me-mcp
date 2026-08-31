import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Resolve de default branch van origin als een `origin/<branch>`-ref.
//
// Hardcoded `origin/main` faalt fataal voor repo's met een andere default
// (bv. scrum4me-docker → master): `git worktree add ... origin/main` geeft
// `fatal: Not a valid object name: 'origin/main'`, en dat legde de hele
// worker-pool in een claim–fail–rollback-lus (ISS-3, gemeten 2026-08-31).
// We laten origin/HEAD wijzen naar de echte default (set-head --auto na
// fetch) en lezen die uit; valt terug op origin/main als origin/HEAD
// onbekend is.
//
// Deze helper stond eerder privé in product-worktree.ts en dekte daardoor
// alleen de product-worktrees; job-worktrees en de push-gate misten hem.
export async function resolveOriginDefaultRef(cwd: string): Promise<string> {
  try {
    await exec('git', ['remote', 'set-head', 'origin', '--auto'], { cwd })
  } catch {
    // origin/HEAD kon niet automatisch gezet worden — probeer toch te lezen
  }
  try {
    const { stdout } = await exec(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd },
    )
    const ref = stdout.trim()
    if (ref) return ref
  } catch {
    // origin/HEAD onbekend — val terug op de historische default
  }
  return 'origin/main'
}
