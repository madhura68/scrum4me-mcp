export type PrRefs = {
  task_codes: string[]
  story_codes: string[]
  pbi_codes: string[]
  doc_paths: string[]
}

const MAX_PER_LIST = 20
const MAX_PATH_LENGTH = 200

// `\bT-` matcht niet binnen `ST-1629`: tussen S en T ligt geen woordgrens.
const TASK_RE = /\bT-\d+\b/g
const STORY_RE = /\bST-\d+\b/g
const PBI_RE = /\bPBI-\d+\b/g
// Paden worden als héél token beoordeeld: de tekst wordt op witruimte en markdown-
// tekens gesplitst, zinsleestekens aan het eind vallen af, en het hele token moet een
// relatief .md-pad zijn. Zo levert `foo.md.bak` of een URL nooit een deelpad op.
const TOKEN_SPLIT_RE = /[\s`'"()<>[\]{},;*|]+/
const TRAILING_PUNCT_RE = /[.:!?]+$/
const PATH_RE = /^(?:[\w.-]+\/)+[\w.-]+\.md$/

function collect(text: string, re: RegExp): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(re)) {
    const value = m[0]
    if (seen.has(value)) continue
    seen.add(value)
    if (seen.size === MAX_PER_LIST) break
  }
  return [...seen]
}

function collectPaths(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(TOKEN_SPLIT_RE)) {
    const token = raw.replace(TRAILING_PUNCT_RE, '')
    if (!PATH_RE.test(token) || !isPlanOrSpecPath(token) || seen.has(token)) continue
    seen.add(token)
    if (seen.size === MAX_PER_LIST) break
  }
  return [...seen]
}

function isPlanOrSpecPath(path: string): boolean {
  if (path.length > MAX_PATH_LENGTH || path.includes('://')) return false
  if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return false
  return path.includes('/plans/') || path.includes('/specs/')
}

/**
 * Verwijzingen naar werk in een PR-beschrijving: taak-, story- en PBI-codes zoals
 * geschreven, en relatieve plan-/specpaden. Pure functie; de resolver zoekt ze op
 * binnen het product van de review-job.
 */
export function extractPrRefs(text: string): PrRefs {
  return {
    task_codes: collect(text, TASK_RE),
    story_codes: collect(text, STORY_RE),
    pbi_codes: collect(text, PBI_RE),
    doc_paths: collectPaths(text),
  }
}
