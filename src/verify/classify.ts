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

const FILES_HEADING = /^(#{1,6})\s*(Bestanden|Files)\b/i
// A clause that names files the task must leave alone ("NIET wijzigen: `x`").
const NEGATIVE_CLAUSE = /\b(niet\s+(wijzigen|aanpassen|aanraken)|ongewijzigd|do\s+not\s+(change|modify|touch|edit))\b/i

// When the plan has "Bestanden"/"Files" sections, only those list the files to
// change; paths elsewhere are context (imports, tips, references). A plan with
// one such section per task has them all read.
function filesSections(plan: string): string {
  const lines = plan.split('\n')
  const kept: string[] = []
  let level = 0 // >0 while inside a files section of that heading level
  let found = false
  for (const line of lines) {
    const files = line.match(FILES_HEADING)
    const heading = line.match(/^(#{1,6})\s/)
    if (files) {
      level = files[1].length
      found = true
    } else if (heading && level > 0 && heading[1].length <= level) {
      level = 0
    } else if (level > 0) {
      kept.push(line)
    }
  }
  return found ? kept.join('\n') : plan
}

// Splits a line into clauses at ";" and at a sentence-ending "." outside
// backticks, and drops the negative ones: "Wijzig `a`; laat `b` ongewijzigd."
// keeps `a` and drops only `b`.
function positiveClauses(line: string): string {
  const clauses: string[] = []
  let current = ''
  let inCode = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '`') inCode = !inCode
    const boundary = !inCode && (c === ';' || (c === '.' && (i + 1 === line.length || /\s/.test(line[i + 1]))))
    if (boundary) {
      clauses.push(current)
      current = ''
    } else {
      current += c
    }
  }
  clauses.push(current)
  return clauses.filter((cl) => !NEGATIVE_CLAUSE.test(cl)).join(';')
}

// One brace group: `a/{b,c}/d.ts` → `a/b/d.ts`, `a/c/d.ts`. Anything else is
// returned as-is (nested or multiple groups are then rejected by looksLikePath).
function expandBraces(token: string): string[] {
  const m = token.match(/^([^{}]*)\{([^{}]*)\}([^{}]*)$/)
  if (!m) return [token]
  return m[2].split(',').map((alt) => `${m[1]}${alt.trim()}${m[3]}`)
}

// Extract the file paths a plan says to change (backtick-quoted or bullet-list headings).
function extractPlanPaths(plan: string): string[] {
  const paths = new Set<string>()
  const scope = filesSections(plan).split('\n').map(positiveClauses).join('\n')

  const backtickRe = /`([^`\s][^`]*[^`\s]|[^`\s])`/g
  let m: RegExpExecArray | null
  while ((m = backtickRe.exec(scope)) !== null) {
    for (const p of expandBraces(m[1].trim())) {
      if (looksLikePath(p)) paths.add(p)
    }
  }

  const bulletRe = /^[-*]\s+\*{0,2}([^\s*][^\s]*)\.([a-zA-Z]{1,6})\*{0,2}\s*[:\n]/gm
  while ((m = bulletRe.exec(scope)) !== null) {
    paths.add(`${m[1]}.${m[2]}`)
  }

  return [...paths]
}

// Heuristic: does this backtick-quoted token look like a file path?
// Excludes code-snippets like `data-debug-label="..."`, `foo()`, `<div>` —
// anything containing operator/quote/bracket chars or an ellipsis is rejected.
// Accepts paths with a slash (multi-segment) or a recognisable file-extension
// suffix (1–6 alphanumeric chars after a final dot, e.g. `.tsx`, `.json`).
function looksLikePath(p: string): boolean {
  if (p.length <= 3) return false
  if (p.includes(' ')) return false
  if (/^[@~]\//.test(p)) return false // module specifier (`@/lib/auth`), not a repo path
  if (/[="'<>()[\]{};,]/.test(p)) return false
  if (/\.{2,}/.test(p)) return false
  if (!p.includes('/') && !/\.[a-zA-Z][a-zA-Z0-9]{0,5}$/.test(p)) return false
  return true
}

// `**/` → zero or more directories, `**` → any characters, `*` → any characters
// within one segment. Like the plain-path match below, the pattern may match a
// suffix of the diff path.
function globToRegExp(glob: string): RegExp {
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const src = glob
    .split('**/')
    .map((dirs) =>
      dirs
        .split('**')
        .map((part) => part.split('*').map(escape).join('[^/]*'))
        .join('.*'),
    )
    .join('(?:.*/)?')
  return new RegExp(`^(?:.*/)?${src}$`)
}

// Path match: exact or suffix match so "classify.ts" matches "src/verify/classify.ts".
// A glob matches by pattern; a path ending in "/" is a directory prefix.
function pathMatches(planPath: string, diffPaths: string[]): boolean {
  const norm = planPath.replace(/\\/g, '/')
  const glob = norm.includes('*') ? globToRegExp(norm) : null
  return diffPaths.some((dp) => {
    const ndp = dp.replace(/\\/g, '/')
    if (glob) return glob.test(ndp)
    if (norm.endsWith('/')) return ndp.startsWith(norm) || ndp.includes(`/${norm}`)
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
  // A glob or directory covers several files: the scope is at least the number
  // of diff paths the plan covers, so only files outside the plan count as creep.
  const inPlan = diffPaths.filter((dp) => planPaths.some((pp) => pathMatches(pp, [dp]))).length
  const ratio = diffPaths.length / Math.max(planPaths.length, inPlan)

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
