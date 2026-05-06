import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getProductWorktreePath } from './worktree-paths.js'

const exec = promisify(execFile)

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
  await exec('git', ['worktree', 'add', '--detach', worktreePath, 'origin/main'], {
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
  await exec('git', ['reset', '--hard', 'origin/main'], { cwd: worktreePath })
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
