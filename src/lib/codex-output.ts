// codex-output.ts — classify a `codex exec --json` (JSONL) run's output into the
// same two terminal signals the daemon loop already understands: token/credit
// expiry (→ exit 3) and rate-limit/overload (→ exit 4). Structured error events
// are preferred; raw-text scan is the fallback.

const CODEX_AUTH_PATTERNS: RegExp[] = [
  /\bunauthorized\b/i,
  /\b401\b/,
  /invalid[_\s-]*api[_\s-]*key/i,
  /\btoken\b[^\n]*\bexpired\b/i,
  /not (?:logged|signed) in/i,
  /codex login/i,
]

const CODEX_OVERLOAD_PATTERNS: RegExp[] = [
  /rate[\s_-]*limit/i,
  /\boverloaded\b/i,
  /\b429\b/,
  /quota[^\n]*exceed/i,
  /too many requests/i,
]

/** Collect the text of JSONL error/failure events; empty string if none parse. */
function extractCodexErrorText(text: string): string {
  const errs: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>
      const type = String(ev.type ?? ev.event ?? '')
      if (/error|fail/i.test(type) || 'error' in ev) {
        errs.push(JSON.stringify(ev))
      }
    } catch {
      // non-JSON line — ignored here; the raw-text fallback still covers it
    }
  }
  return errs.join('\n')
}

export interface CodexOutputClass {
  tokenExpired: boolean
  apiOverloaded: boolean
}

export function classifyCodexOutput(text: string): CodexOutputClass {
  const haystack = extractCodexErrorText(text) || text
  const tokenExpired = CODEX_AUTH_PATTERNS.some((p) => p.test(haystack))
  const apiOverloaded = !tokenExpired && CODEX_OVERLOAD_PATTERNS.some((p) => p.test(haystack))
  return { tokenExpired, apiOverloaded }
}
