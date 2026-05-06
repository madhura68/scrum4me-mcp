import * as os from 'node:os'
import * as path from 'node:path'

export const SYSTEM_WORKTREE_DIRS = new Set(['_products'])

export function getWorktreeRoot(): string {
  return (
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    ?? path.join(os.homedir(), '.scrum4me-agent-worktrees')
  )
}

export function getProductWorktreePath(productId: string): string {
  return path.join(getWorktreeRoot(), '_products', productId)
}

export function getProductWorktreeLockPath(productId: string): string {
  return path.join(getWorktreeRoot(), '_products', `${productId}.lock`)
}
