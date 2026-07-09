// BEWUST DUPLICAAT van Scrum4Me/lib/ideas/verify-required-guard.ts (IDEA-139).
// Wijzigingen in beide doorvoeren (lockstep met de materialize-duplicaat).
/**
 * Detecteert of een implementation_plan verkennings-/inspectiestappen bevat die
 * onder strikt verify_required=ALIGNED gegarandeerd een false-negative bij de
 * verify-gate (scrum4me-mcp verify_sprint_task -> classifyDiffAgainstPlan)
 * opleveren. Zie
 * docs/superpowers/specs/2026-07-08-verify-required-exploration-guard-design.md.
 *
 * Puur: geen DB/Prisma-afhankelijkheden. Werkt op backtick-quoted pad-tokens.
 *
 * Diffbaarheid: de gate normaliseert backslashes (pathMatches) en doet
 * suffix-matching, dus backslash-/leading-slash-paden matchen alsnog tegen
 * repo-relatieve diff-paden -> die triggeren hier bewust NIET. norm() spiegelt
 * precies die gate-normalisatie.
 */

// Backtick-token lijkt op een pad (spiegelt classify.ts::looksLikePath):
// bevat een slash of een file-extensie; geen spaties/operators/ellipsis.
function looksLikePath(p: string): boolean {
  if (p.length <= 3) return false
  if (p.includes(' ')) return false
  if (/[="'<>()[\]{};,]/.test(p)) return false
  if (/\.{2,}/.test(p)) return false
  if (!p.includes('/') && !/\.[a-zA-Z][a-zA-Z0-9]{0,5}$/.test(p)) return false
  return true
}

const norm = (p: string) => p.replace(/\\/g, '/')

// Schrijf-/edit-werkwoorden (imperatief). Split-constructies (pas..aan,
// voeg..toe, zet..in) apart. Bevat destructief-in-place verbs (strip/refactor/
// herschrijf/overschrijf/herstel/fix) zodat die regels als edit tellen.
const WRITE_VERB =
  /\b(maak|create|voeg\s+toe|add|wijzig\w*|change|update|vervang\w*|replace|hernoem\w*|rename|verwijder\w*|delete|remove|regenereer\w*|regenerate|aanpas\w*|strip\w*|refactor\w*|herschrijf\w*|herschrijv\w*|overschrijf\w*|rewrite\w*|herstel\w*|fix)\b|\bpas\b[^\n]*?\baan\b|\bvoeg\b[^\n]*?\btoe\b|\bzet\b[^\n]*?\bin\b/i

// Read-only / inspectie-markers op regelniveau. `grep` alleen als los commando
// (niet in compounds als `grep-fallback`).
const READONLY_MARKER =
  /\b(read-only|alleen lezen|niet editen|niet wijzigen|niet aanraken|ongewijzigd|referentie\w*|zoek\w*|inspecteer|inspect|lees|read|controleer|verifieer|verify|check|nagaan|bestudeer|study|bekijk\w*)\b|\bgrep\b(?!-)/i

// Onvoorwaardelijke bron-frases, geankerd op het directe pre-token-segment
// ([^`,]*$): geen komma/backtick tussen frase en token.
const SOURCE_ANCHORED =
  /\b(op basis van|via template|zoals|gebaseerd op|based on|aan de hand van)\b[^`,]*$/i

// import/lees/kopieer/haal ... uit/from <token>: token is import-/lees-bron.
// import\w* vangt NL-inflectie (Importeer/importeren).
// `.*` (niet `[^`]*`) zodat een tussenliggend backtick-token de import-verb en
// `uit`/`from` niet scheidt, bv. "Import `X` uit `Y`". uit/from blijft geankerd
// op de directe pre-token-positie via `\b(uit|from)\s*$`.
const IMPORT_SOURCE_BEFORE =
  /\b(import\w*|kopieer|copy|haal|fetch|get|lees|read)\b.*\b(uit|from)\s*$/i

// `before` eindigt op een read/inspect-verb (direct pre-token-segment).
const READ_BEFORE =
  /\b(lees|read|inspecteer|inspect|zoek\w*|bekijk\w*|bestudeer|controleer|verifieer)\b[^`]*$|\bgrep\b(?!-)[^`]*$/i

type Tok = { token: string; before: string }

function* backtickPaths(line: string): Generator<Tok> {
  const re = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const token = m[1].trim()
    if (looksLikePath(token)) yield { token, before: line.slice(0, m.index) }
  }
}

const isBareDir = (t: string) => t.endsWith('/')
const isUrl = (t: string) => /^https?:\/\//i.test(t)
const isExtensionlessRoute = (t: string) =>
  t.startsWith('/') && !/\.[a-zA-Z][a-zA-Z0-9]{0,5}$/.test(t)

// Token staat in een bron-/read-/import-context -> geen edit-target.
const isSourceBefore = (before: string): boolean =>
  SOURCE_ANCHORED.test(before) || IMPORT_SOURCE_BEFORE.test(before) || READ_BEFORE.test(before)

export function planHasExplorationSteps(plan: string | null): boolean {
  if (!plan || plan.trim() === '') return false
  const lines = plan.split('\n')

  // Pass 1: edit-targets = backtick-paden op schrijf-regels, behalve tokens die
  // in een bron-/read-/import-context staan (die zijn bron, geen edit-target).
  const editTargets = new Set<string>()
  for (const line of lines) {
    if (!WRITE_VERB.test(line)) continue
    for (const { token, before } of backtickPaths(line)) {
      if (isSourceBefore(before)) continue
      editTargets.add(norm(token))
    }
  }

  // Pass 2: zoek een trigger-token.
  for (const line of lines) {
    const hasWrite = WRITE_VERB.test(line)
    for (const { token, before } of backtickPaths(line)) {
      // Onvoorwaardelijk niet-diffbaar (kale dir / extensie-loze route / URL).
      if (isBareDir(token) || isExtensionlessRoute(token) || isUrl(token)) return true

      // Voorwaardelijk -> alleen wanneer geen edit-target.
      if (editTargets.has(norm(token))) continue
      if (READONLY_MARKER.test(line)) return true
      if (SOURCE_ANCHORED.test(before)) return true
      if (!hasWrite && IMPORT_SOURCE_BEFORE.test(before)) return true
    }
  }

  return false
}
