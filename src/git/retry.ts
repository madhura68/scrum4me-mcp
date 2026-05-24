// Transient-git-error retry helpers, shared by the claim/worktree flow.

export function isTransientGitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /index\.lock|could not lock|unable to access|could not resolve host|connection (timed out|refused|reset)|early EOF|fetch-pack|RPC failed|the remote end hung up|timed out|temporar/i.test(
    msg,
  )
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries?: number
    baseDelayMs?: number
    isRetryable?: (err: unknown) => boolean
    onRetry?: (attempt: number, err: unknown) => void
  } = {},
): Promise<T> {
  const { retries = 2, baseDelayMs = 200, isRetryable = () => true, onRetry } = opts
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === retries || !isRetryable(err)) throw err
      onRetry?.(attempt + 1, err)
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt))
    }
  }
  throw lastErr
}
