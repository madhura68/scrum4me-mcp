import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getProductWorktreePath } from './worktree-paths.js'

const exec = promisify(execFile)

// Resolve de default branch van origin als een `origin/<branch>`-ref.
// Hardcoded `origin/main` faalt fataal voor repo's met een andere default
// (bv. scrum4me-docker → master): `git worktree add ... origin/main` geeft
// `fatal: invalid reference: origin/main`, wat een hele worker-pool kan
// platleggen. We laten origin/HEAD wijzen naar de echte default (set-head
// --auto na fetch) en lezen die uit; valt terug op origin/main als
// origin/HEAD onbekend is.
async function resolveOriginDefaultRef(cwd: string): Promise<string> {
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

export async function getOrCreateProductWorktree(opts: {
  repoRoot: string
  productId: string
}): Promise<{ worktreePath: string; created: boolean }> {
  const worktreePath = getProductWorktreePath(opts.productId)
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })

  try {
    await fs.access(worktreePath)
    return { worktreePath, created: false }
  } catch {
    // Path bestaat niet — aanmaken
  }

  await exec('git', ['fetch', 'origin', '--prune'], { cwd: opts.repoRoot })
  const baseRef = await resolveOriginDefaultRef(opts.repoRoot)
  await exec('git', ['worktree', 'add', '--detach', worktreePath, baseRef], {
    cwd: opts.repoRoot,
  })

  // Resolve REAL exclude-pad (linked worktree heeft .git als file, niet directory)
  const { stdout } = await exec('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: worktreePath,
  })
  const excludePath = path.resolve(worktreePath, stdout.trim())
  const existing = await fs.readFile(excludePath, 'utf8').catch(() => '')
  if (!existing.split('\n').includes('.scratch/')) {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await fs.appendFile(excludePath, `${sep}.scratch/\n`)
  }

  return { worktreePath, created: true }
}

export async function syncProductWorktree(opts: { worktreePath: string }): Promise<void> {
  const { worktreePath } = opts
  await exec('git', ['fetch', 'origin', '--prune'], { cwd: worktreePath })
  const baseRef = await resolveOriginDefaultRef(worktreePath)
  await exec('git', ['reset', '--hard', baseRef], { cwd: worktreePath })
  await exec('git', ['clean', '-fd', '-e', '.scratch/'], { cwd: worktreePath })
  // Wis .scratch/ inhoud, behoud de map
  const scratch = path.join(worktreePath, '.scratch')
  await fs.rm(scratch, { recursive: true, force: true })
  await fs.mkdir(scratch, { recursive: true })
}

export async function removeProductWorktree(opts: {
  repoRoot: string
  productId: string
}): Promise<{ removed: boolean }> {
  const worktreePath = getProductWorktreePath(opts.productId)
  try {
    await exec('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: opts.repoRoot,
    })
    return { removed: true }
  } catch {
    return { removed: false }
  }
}
