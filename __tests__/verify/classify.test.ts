import { describe, it, expect } from 'vitest'
import { classifyDiffAgainstPlan } from '../../src/verify/classify.js'

// Helpers to build minimal unified diff snippets
function makeDiff(files: string[], linesPerFile = 5): string {
  return files
    .map(
      (f) =>
        `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n` +
        Array.from({ length: linesPerFile }, (_, i) => `+added line ${i}`).join('\n'),
    )
    .join('\n')
}

function largeFileDiff(file: string, addedLines = 60): string {
  return (
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` +
    Array.from({ length: addedLines }, (_, i) => `+line ${i}`).join('\n')
  )
}

describe('classifyDiffAgainstPlan — empty diff', () => {
  it('returns EMPTY for blank diff string', () => {
    const r = classifyDiffAgainstPlan({ diff: '', plan: 'some plan' })
    expect(r.result).toBe('EMPTY')
    expect(r.reasoning).toMatch(/geen bestandswijzigingen/i)
  })

  it('returns EMPTY for diff with no +++ b/ lines', () => {
    const r = classifyDiffAgainstPlan({ diff: 'Binary files differ\n', plan: 'plan' })
    expect(r.result).toBe('EMPTY')
  })
})

describe('classifyDiffAgainstPlan — no plan baseline', () => {
  it('returns ALIGNED for null plan with small diff', () => {
    const r = classifyDiffAgainstPlan({ diff: makeDiff(['src/foo.ts']), plan: null })
    expect(r.result).toBe('ALIGNED')
  })

  it('returns ALIGNED for empty string plan with small diff', () => {
    const r = classifyDiffAgainstPlan({ diff: makeDiff(['src/foo.ts']), plan: '   ' })
    expect(r.result).toBe('ALIGNED')
  })

  it('returns DIVERGENT for null plan with large diff (>50 changed lines)', () => {
    const r = classifyDiffAgainstPlan({ diff: largeFileDiff('src/big.ts', 60), plan: null })
    expect(r.result).toBe('DIVERGENT')
  })
})

describe('classifyDiffAgainstPlan — plan has no extractable paths', () => {
  const plan = 'Add a new feature. Update the logic. Write tests.'

  it('returns ALIGNED for small diff when plan has no paths', () => {
    const r = classifyDiffAgainstPlan({ diff: makeDiff(['src/feature.ts']), plan })
    expect(r.result).toBe('ALIGNED')
  })

  it('returns DIVERGENT for large diff when plan has no paths', () => {
    const r = classifyDiffAgainstPlan({ diff: largeFileDiff('src/feature.ts', 60), plan })
    expect(r.result).toBe('DIVERGENT')
  })
})

describe('classifyDiffAgainstPlan — PARTIAL coverage', () => {
  const plan = 'Edit `src/api.ts` and `src/ui.ts`.'

  it('returns PARTIAL when only one of two plan paths is in diff', () => {
    const diff = makeDiff(['src/api.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('PARTIAL')
    expect(r.reasoning).toMatch(/1\/2/)
    expect(r.reasoning).toMatch(/ontbrekend/i)
  })

  it('returns PARTIAL when none of the plan paths are in diff', () => {
    const diff = makeDiff(['src/unrelated.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('PARTIAL')
    expect(r.reasoning).toMatch(/0\/2/)
  })
})

describe('classifyDiffAgainstPlan — ALIGNED', () => {
  it('returns ALIGNED when all plan paths are in diff with ratio < 3', () => {
    const plan = 'Modify `src/a.ts` and `src/b.ts`.'
    const diff = makeDiff(['src/a.ts', 'src/b.ts', 'src/c.ts']) // ratio 3/2 = 1.5 < 3
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('ALIGNED')
    expect(r.reasoning).toMatch(/alle 2/i)
  })

  it('returns ALIGNED for exact 1-to-1 match', () => {
    const plan = 'Update `src/verify/classify.ts`.'
    const diff = makeDiff(['src/verify/classify.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('ALIGNED')
  })

  it('suffix-matches short plan path against full diff path', () => {
    const plan = 'Edit `classify.ts` in the verify module.'
    const diff = makeDiff(['src/verify/classify.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('ALIGNED')
  })
})

describe('classifyDiffAgainstPlan — DIVERGENT (scope creep)', () => {
  it('returns DIVERGENT when diff has 3x+ more paths than plan', () => {
    const plan = 'Update `src/a.ts`.'
    // 1 plan path, 4 diff paths → ratio 4.0 >= 3
    const diff = makeDiff(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('DIVERGENT')
    expect(r.reasoning).toMatch(/4\.0x/)
  })

  it('shows extra file paths in reasoning', () => {
    const plan = 'Modify `src/core.ts`.'
    const diff = makeDiff(['src/core.ts', 'src/extra1.ts', 'src/extra2.ts', 'src/extra3.ts', 'src/extra4.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('DIVERGENT')
    expect(r.reasoning).toMatch(/extra/i)
  })
})
