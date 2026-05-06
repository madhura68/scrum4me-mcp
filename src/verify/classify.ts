export type VerifyResultValue = 'ALIGNED' | 'PARTIAL' | 'EMPTY' | 'DIVERGENT'

export interface ClassifyResult {
  result: VerifyResultValue
  reasoning: string
}

// Extract changed file paths from a unified diff. Reads both "+++ b/<path>"
// (created/modified files) and "--- a/<path>" (deleted/modified files), so
// pure-delete commits (where +++ is /dev/null) are still recognised.
function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>()
  for (const line of diff.split('\n')) {
    const plus = line.match(/^\+\+\+ b\/(.+)$/)
    if (plus && plus[1].trim() !== '/dev/null') paths.add(plus[1].trim())
    const minus = line.match(/^--- a\/(.+)$/)
    if (minus && minus[1].trim() !== '/dev/null') paths.add(minus[1].trim())
  }
  return [...paths]
}

// Extract file paths mentioned in a plan (backtick-quoted, parenthesised, or bullet-list headings).
function extractPlanPaths(plan: string): string[] {
  const paths = new Set<string>()

  const backtickRe = /`([^`\s][^`]*[^`\s]|[^`\s])`/g
  let m: RegExpExecArray | null
  while ((m = backtickRe.exec(plan)) !== null) {
    const p = m[1].trim()
    if ((p.includes('/') || p.includes('.')) && !p.includes(' ') && p.length > 3) paths.add(p)
  }

  const bulletRe = /^[-*]\s+\*{0,2}([^\s*][^\s]*)\.([a-zA-Z]{1,6})\*{0,2}\s*[:\n]/gm
  while ((m = bulletRe.exec(plan)) !== null) {
    paths.add(`${m[1]}.${m[2]}`)
  }

  return [...paths]
}

// Path match: exact or suffix match so "classify.ts" matches "src/verify/classify.ts".
function pathMatches(planPath: string, diffPaths: string[]): boolean {
  const norm = planPath.replace(/\\/g, '/')
  return diffPaths.some((dp) => {
    const ndp = dp.replace(/\\/g, '/')
    return ndp === norm || ndp.endsWith(`/${norm}`) || norm.endsWith(`/${ndp}`)
  })
}

/**
 * Classify a unified git diff against an implementation plan.
 * Returns a VerifyResult (ALIGNED|PARTIAL|EMPTY|DIVERGENT) plus human-readable reasoning.
 *
 * v1 heuristic — no LLM required:
 *   - No file changes in diff                              → EMPTY
 *   - Plan empty, diff ≤50 changed lines                  → ALIGNED (targeted fix)
 *   - Plan empty, diff >50 changed lines                  → DIVERGENT (too large to trust)
 *   - Plan paths < 100% covered in diff                   → PARTIAL
 *   - Plan paths 100% covered, diff ≥3× more paths        → DIVERGENT (scope creep)
 *   - Plan paths 100% covered, diff <3× more paths        → ALIGNED
 */
export function classifyDiffAgainstPlan(opts: {
  diff: string
  plan: string | null
}): ClassifyResult {
  const { diff, plan } = opts

  const diffPaths = extractDiffPaths(diff)
  if (diffPaths.length === 0) {
    return { result: 'EMPTY', reasoning: 'Geen bestandswijzigingen in de diff.' }
  }

  // Whitespace-only / no-content edge case: paths are present but every +/-
  // line is a diff header (---/+++) or whitespace-only. Treat as EMPTY so the
  // gate rejects DONE for tasks that didn't really change anything.
  const meaningfulChange = diff.split('\n').some((l) => {
    if (!/^[+-]/.test(l)) return false
    if (/^[+-]{3}\s/.test(l)) return false // diff header line (--- / +++)
    return l.slice(1).trim().length > 0
  })
  if (!meaningfulChange) {
    return {
      result: 'EMPTY',
      reasoning: 'Diff bevat alleen headers of whitespace — geen daadwerkelijke content-wijzigingen.',
    }
  }

  const changedLines = diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length

  if (!plan || plan.trim().length === 0) {
    if (changedLines > 50) {
      return {
        result: 'DIVERGENT',
        reasoning: `Geen plan-baseline aanwezig; ${changedLines} gewijzigde regels — te groot om als aligned te bestempelen.`,
      }
    }
    return {
      result: 'ALIGNED',
      reasoning: `Geen plan-baseline; ${diffPaths.length} bestand(en) gewijzigd — kleine gerichte wijziging.`,
    }
  }

  const planPaths = extractPlanPaths(plan)

  if (planPaths.length === 0) {
    if (changedLines > 50) {
      return {
        result: 'DIVERGENT',
        reasoning: `Plan vermeldt geen specifieke paden; ${changedLines} gewijzigde regels — te groot om als aligned te bestempelen.`,
      }
    }
    return {
      result: 'ALIGNED',
      reasoning: `Plan vermeldt geen specifieke paden; ${diffPaths.length} bestand(en) gewijzigd.`,
    }
  }

  const covered = planPaths.filter((pp) => pathMatches(pp, diffPaths))
  const coverage = covered.length / planPaths.length
  const ratio = diffPaths.length / planPaths.length

  if (coverage < 1) {
    const missing = planPaths.filter((pp) => !pathMatches(pp, diffPaths))
    const missingStr = missing.slice(0, 3).join(', ') + (missing.length > 3 ? ` + ${missing.length - 3} meer` : '')
    return {
      result: 'PARTIAL',
      reasoning: `${covered.length}/${planPaths.length} plan-paden aanwezig in diff. Ontbrekend: ${missingStr}.`,
    }
  }

  if (ratio >= 3) {
    const extra = diffPaths.filter((dp) => !planPaths.some((pp) => pathMatches(pp, [dp])))
    const extraStr = extra.slice(0, 3).join(', ') + (extra.length > 3 ? ` + ${extra.length - 3} meer` : '')
    return {
      result: 'DIVERGENT',
      reasoning: `Alle ${planPaths.length} plan-paden aanwezig, maar diff bevat ${diffPaths.length} paden (${ratio.toFixed(1)}x). Extra: ${extraStr}.`,
    }
  }

  return {
    result: 'ALIGNED',
    reasoning: `Alle ${planPaths.length} plan-paden aanwezig in diff (${diffPaths.length} totaal; ${ratio.toFixed(1)}x).`,
  }
}
