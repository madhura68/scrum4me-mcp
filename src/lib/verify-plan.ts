// Core logic for verify_task_against_plan: diff, AC heuristic, drift score.

export function parseAcceptanceCriteria(text: string | null): string[] {
  if (!text) return []
  return text
    .split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
    .filter((line) => line.length > 0)
}

export function extractKeywords(text: string): string[] {
  const raw = text.split(/[\s,;:()[\]{}]+/)
  const keywords: Set<string> = new Set()
  for (const word of raw) {
    const clean = word.replace(/^[^\w./\-]+|[^\w./\-]+$/g, '')
    if (!clean) continue
    if (clean.includes('.') || clean.includes('/')) {
      keywords.add(clean.toLowerCase()) // filenames / paths
    } else if (/^[A-Z][a-z]/.test(clean) && clean.length > 4) {
      keywords.add(clean.toLowerCase()) // CamelCase identifiers
    } else if (clean.length > 6) {
      keywords.add(clean.toLowerCase()) // long lowercase words
    }
  }
  return [...keywords]
}

export function checkACStatus(acText: string, corpus: string): '✓' | '✗' | '?' {
  const keywords = extractKeywords(acText)
  if (keywords.length === 0) return '?'
  const corpusLower = corpus.toLowerCase()
  const matched = keywords.filter((kw) => corpusLower.includes(kw))
  const ratio = matched.length / keywords.length
  if (ratio >= 0.5) return '✓'
  if (ratio > 0) return '?'
  return '✗'
}

export function computeDriftScore(results: Array<{ status: '✓' | '✗' | '?' }>): number {
  if (results.length === 0) return 0
  const passed = results.filter((r) => r.status === '✓').length
  return Math.round((passed / results.length) * 100)
}

export function lineDiff(snapshot: string, current: string): string | null {
  if (snapshot === current) return null
  const aLines = snapshot.split('\n')
  const bLines = current.split('\n')
  const out: string[] = []
  const len = Math.max(aLines.length, bLines.length)
  for (let i = 0; i < len; i++) {
    const a = i < aLines.length ? aLines[i] : undefined
    const b = i < bLines.length ? bLines[i] : undefined
    if (a === b) continue
    if (a !== undefined) out.push(`- ${a}`)
    if (b !== undefined) out.push(`+ ${b}`)
  }
  return out.length > 0 ? out.join('\n') : null
}

export interface ACResult {
  text: string
  status: '✓' | '✗' | '?'
}

export interface VerifyResult {
  taskId: string
  taskTitle: string
  hasBaseline: boolean
  planSnapshot: string | null
  currentPlan: string | null
  planEdited: boolean
  planDiff: string | null
  implementationLogs: string[]
  commits: Array<{ hash: string | null; message: string | null }>
  acceptanceCriteria: ACResult[]
  driftScore: number
}

export function buildVerifyResult(opts: {
  taskId: string
  taskTitle: string
  planSnapshot: string | null
  currentPlan: string | null
  acceptanceCriteriaText: string | null
  implementationLogs: string[]
  commits: Array<{ hash: string | null; message: string | null }>
}): VerifyResult {
  const { taskId, taskTitle, planSnapshot, currentPlan, acceptanceCriteriaText, implementationLogs, commits } = opts

  const hasBaseline = planSnapshot !== null

  const planEdited = hasBaseline && planSnapshot !== (currentPlan ?? '')
  const planDiff = planEdited ? lineDiff(planSnapshot!, currentPlan ?? '') : null

  const corpus = [
    currentPlan ?? '',
    ...implementationLogs,
    ...commits.map((c) => `${c.hash ?? ''} ${c.message ?? ''}`),
  ].join('\n')

  const acTexts = parseAcceptanceCriteria(acceptanceCriteriaText)
  const acceptanceCriteria: ACResult[] = acTexts.map((text) => ({
    text,
    status: checkACStatus(text, corpus),
  }))

  const driftScore = computeDriftScore(acceptanceCriteria)

  return {
    taskId,
    taskTitle,
    hasBaseline,
    planSnapshot,
    currentPlan,
    planEdited,
    planDiff,
    implementationLogs,
    commits,
    acceptanceCriteria,
    driftScore,
  }
}

export function renderMarkdownReport(r: VerifyResult): string {
  const lines: string[] = []

  lines.push(`# Verify task: ${r.taskTitle} (\`${r.taskId}\`)`, '')

  lines.push('## Plan')
  if (!r.hasBaseline) {
    lines.push('- Snapshot: **no baseline** (job was claimed before snapshot feature)')
  } else {
    const snipLen = 120
    const snip = (r.planSnapshot ?? '').length > snipLen
      ? (r.planSnapshot ?? '').slice(0, snipLen) + '…'
      : (r.planSnapshot ?? '(leeg)')
    lines.push(`- Snapshot: ${snip}`)
  }
  const curSnip = (r.currentPlan ?? '').length > 120
    ? (r.currentPlan ?? '').slice(0, 120) + '…'
    : (r.currentPlan ?? '(leeg)')
  lines.push(`- Current: ${curSnip}`)
  lines.push(`- Edited onderweg: **${r.planEdited ? 'yes' : 'no'}**`)

  if (r.planEdited && r.planDiff) {
    lines.push('', '### Diff (snapshot → current)', '```diff', r.planDiff, '```')
  }
  lines.push('')

  const passed = r.acceptanceCriteria.filter((a) => a.status === '✓').length
  const total = r.acceptanceCriteria.length
  lines.push(`## AC-checks (${passed}/${total} ✓ — drift-score ${r.driftScore}%)`)
  if (total === 0) {
    lines.push('_Geen acceptance criteria op de parent story._')
  } else {
    for (const ac of r.acceptanceCriteria) {
      lines.push(`- ${ac.status} ${ac.text}`)
    }
  }
  lines.push('')

  lines.push('## Realisatie')
  lines.push(`- ${r.implementationLogs.length} log_implementation-entr${r.implementationLogs.length === 1 ? 'y' : 'ies'}`)
  if (r.commits.length === 0) {
    lines.push('- Geen commits gelogd')
  } else {
    for (const c of r.commits) {
      lines.push(`- commit \`${c.hash ?? '?'}\` — ${c.message ?? '(geen bericht)'}`)
    }
  }
  lines.push('')

  lines.push('---')
  lines.push('⚠️ Heuristiek-rapport — handmatige PR-review blijft nodig')

  return lines.join('\n')
}
