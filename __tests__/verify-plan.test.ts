import { describe, it, expect } from 'vitest'
import {
  parseAcceptanceCriteria,
  extractKeywords,
  checkACStatus,
  computeDriftScore,
  lineDiff,
  buildVerifyResult,
  renderMarkdownReport,
} from '../src/lib/verify-plan.js'

describe('parseAcceptanceCriteria', () => {
  it('returns empty array for null', () => {
    expect(parseAcceptanceCriteria(null)).toEqual([])
  })

  it('parses dash-prefixed lines', () => {
    const text = '- First AC\n- Second AC\n- Third AC'
    expect(parseAcceptanceCriteria(text)).toEqual(['First AC', 'Second AC', 'Third AC'])
  })

  it('strips numbered prefixes', () => {
    const text = '1. Do this\n2. Do that'
    expect(parseAcceptanceCriteria(text)).toEqual(['Do this', 'Do that'])
  })

  it('ignores blank lines', () => {
    const text = '- AC1\n\n- AC2'
    expect(parseAcceptanceCriteria(text)).toEqual(['AC1', 'AC2'])
  })
})

describe('extractKeywords', () => {
  it('extracts filenames with extensions', () => {
    const kws = extractKeywords('update wait-for-job.ts and verify-plan.ts')
    expect(kws).toContain('wait-for-job.ts')
    expect(kws).toContain('verify-plan.ts')
  })

  it('extracts long words', () => {
    const kws = extractKeywords('implementation snapshot detection')
    expect(kws).toContain('implementation')
    expect(kws).toContain('snapshot')
    expect(kws).toContain('detection')
  })

  it('returns unique keywords', () => {
    const kws = extractKeywords('implementation implementation')
    const count = kws.filter((k) => k === 'implementation').length
    expect(count).toBe(1)
  })
})

describe('checkACStatus', () => {
  it('returns ✓ when majority of keywords found in corpus', () => {
    const ac = 'plan_snapshot field added to ClaudeJob'
    const corpus = 'added plan_snapshot field to claudejob schema migration'
    expect(checkACStatus(ac, corpus)).toBe('✓')
  })

  it('returns ✗ when no keywords found', () => {
    const ac = 'zxqwerty obscure feature nobody implemented'
    const corpus = 'completely different log content about other things'
    expect(checkACStatus(ac, corpus)).toBe('✗')
  })

  it('returns ? when partial match', () => {
    const ac = 'snapshot captured at claim time with plan_snapshot field'
    const corpus = 'snapshot written to database'
    const result = checkACStatus(ac, corpus)
    expect(['?', '✓']).toContain(result)
  })

  it('returns ? for very short AC with no extractable keywords', () => {
    expect(checkACStatus('Ok', 'anything')).toBe('?')
  })
})

describe('computeDriftScore', () => {
  it('returns 100 when all pass', () => {
    const results = [{ status: '✓' as const }, { status: '✓' as const }]
    expect(computeDriftScore(results)).toBe(100)
  })

  it('returns 0 when all fail', () => {
    const results = [{ status: '✗' as const }, { status: '✗' as const }]
    expect(computeDriftScore(results)).toBe(0)
  })

  it('returns 50 for half passing', () => {
    const results = [{ status: '✓' as const }, { status: '✗' as const }]
    expect(computeDriftScore(results)).toBe(50)
  })

  it('returns 0 for empty list', () => {
    expect(computeDriftScore([])).toBe(0)
  })
})

describe('lineDiff', () => {
  it('returns null when strings are identical', () => {
    expect(lineDiff('line1\nline2', 'line1\nline2')).toBeNull()
  })

  it('shows added lines with +', () => {
    const diff = lineDiff('line1', 'line1\nline2')
    expect(diff).toContain('+ line2')
  })

  it('shows removed lines with -', () => {
    const diff = lineDiff('line1\nline2', 'line1')
    expect(diff).toContain('- line2')
  })

  it('shows changed lines as remove+add pair', () => {
    const diff = lineDiff('old line', 'new line')
    expect(diff).toContain('- old line')
    expect(diff).toContain('+ new line')
  })
})

describe('buildVerifyResult + renderMarkdownReport', () => {
  it('scenario: plan unchanged, all ACs matched in logs — 100% drift score', () => {
    const plan = 'Add plan_snapshot field to ClaudeJob schema'
    const result = buildVerifyResult({
      taskId: 'task-1',
      taskTitle: 'Prisma migration',
      planSnapshot: plan,
      currentPlan: plan,
      acceptanceCriteriaText: '- plan_snapshot field added\n- migration created',
      implementationLogs: ['Added plan_snapshot field, created migration file for claudejob'],
      commits: [{ hash: 'abc123', message: 'feat: add plan_snapshot to claudejob schema' }],
    })

    expect(result.planEdited).toBe(false)
    expect(result.planDiff).toBeNull()
    expect(result.hasBaseline).toBe(true)
    expect(result.driftScore).toBeGreaterThanOrEqual(50)

    const report = renderMarkdownReport(result)
    expect(report).toContain('Edited onderweg: **no**')
    expect(report).toContain('drift-score')
  })

  it('scenario: plan edited onderweg — planEdited=true, diff in output', () => {
    const result = buildVerifyResult({
      taskId: 'task-2',
      taskTitle: 'Wait for job update',
      planSnapshot: 'Original plan\nStep 1',
      currentPlan: 'Original plan\nStep 1 revised\nStep 2 added',
      acceptanceCriteriaText: null,
      implementationLogs: [],
      commits: [],
    })

    expect(result.planEdited).toBe(true)
    expect(result.planDiff).not.toBeNull()
    expect(result.planDiff).toContain('- Step 1')
    expect(result.planDiff).toContain('+ Step 1 revised')

    const report = renderMarkdownReport(result)
    expect(report).toContain('Edited onderweg: **yes**')
    expect(report).toContain('```diff')
  })

  it('scenario: AC without match in logs → ✗', () => {
    const result = buildVerifyResult({
      taskId: 'task-3',
      taskTitle: 'Unimplemented feature',
      planSnapshot: 'some plan',
      currentPlan: 'some plan',
      acceptanceCriteriaText: '- zxcvbnm_completely_missing_feature deployed',
      implementationLogs: ['unrelated work done here'],
      commits: [],
    })

    expect(result.acceptanceCriteria[0].status).toBe('✗')
    expect(result.driftScore).toBe(0)
  })

  it('scenario: stale claim (snapshot null) → no baseline in report', () => {
    const result = buildVerifyResult({
      taskId: 'task-4',
      taskTitle: 'Old job',
      planSnapshot: null,
      currentPlan: 'current plan',
      acceptanceCriteriaText: '- something done',
      implementationLogs: ['something done here'],
      commits: [],
    })

    expect(result.hasBaseline).toBe(false)
    expect(result.planEdited).toBe(false)

    const report = renderMarkdownReport(result)
    expect(report).toContain('no baseline')
  })
})
