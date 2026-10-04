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
// Een padkandidaat begint niet direct na een woordteken, `/`, `.` of `-`; zo levert een
// URL of een absoluut pad geen deelpad op dat alsnog relatief lijkt.
const PATH_RE = /(?<![\w/.-])((?:[\w.-]+\/)+[\w.-]+\.md)(?![\w/-])/g

function collect(text: string, re: RegExp, keep: (match: string) => boolean = () => true): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(re)) {
    const value = m[1] ?? m[0]
    if (!keep(value) || seen.has(value)) continue
    seen.add(value)
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
    doc_paths: collect(text, PATH_RE, isPlanOrSpecPath),
  }
}
