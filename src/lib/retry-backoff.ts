// Full-jitter backoff for the bounded DB retry loops.
//
// Without a wait, every loser of a contended transaction retries in the same
// tick as the other losers and re-collides in lockstep: measured on Postgres
// 17.9, six concurrent create_pbi calls burned all four attempts and 16 of 60
// handlers still failed. Randomising the delay across the whole ceiling (full
// jitter) is what decorrelates them; a fixed delay would just move the
// lockstep later.

export const BASE_BACKOFF_MS = 5
export const MAX_BACKOFF_MS = 100

export function backoffDelayMs(retry: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** retry)
  return Math.round(random() * ceiling)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
