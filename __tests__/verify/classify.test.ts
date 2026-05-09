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

// Helper voor pure-delete diffs: +++ /dev/null betekent dat het bestand
// volledig verwijderd is. Pad zit alleen nog in de "--- a/<path>" regel.
function makeDeleteDiff(files: string[], linesPerFile = 5): string {
  return files
    .map(
      (f) =>
        `diff --git a/${f} b/${f}\ndeleted file mode 100644\n--- a/${f}\n+++ /dev/null\n` +
        Array.from({ length: linesPerFile }, (_, i) => `-removed line ${i}`).join('\n'),
    )
    .join('\n')
}

describe('classifyDiffAgainstPlan — delete-only commits', () => {
  it('herkent delete-only diff (geen +++ b/, wel --- a/) als ALIGNED bij matchend plan', () => {
    const plan = 'Verwijder `src/old-helper.ts` — niet meer gebruikt.'
    const diff = makeDeleteDiff(['src/old-helper.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('ALIGNED')
  })

  it('retourneert PARTIAL wanneer plan meer paden noemt dan zijn verwijderd', () => {
    const plan = 'Verwijder `src/a.ts` en `src/b.ts`.'
    const diff = makeDeleteDiff(['src/a.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('PARTIAL')
  })

  it('retourneert ALIGNED voor delete-only diff zonder plan-baseline', () => {
    const diff = makeDeleteDiff(['src/old.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan: null })
    expect(r.result).toBe('ALIGNED')
  })

  it('retourneert nog steeds EMPTY voor echt lege diff', () => {
    const r = classifyDiffAgainstPlan({ diff: '', plan: 'Verwijder `src/x.ts`.' })
    expect(r.result).toBe('EMPTY')
  })
})

// Pseudo-paths in plans (code-snippets, attribute-syntax, ellipses) moeten
// niet als plan-paden meetellen — anders krijg je PARTIAL terwijl het werk
// volledig gedaan is. Regression-guard voor T-815-incident (sprint
// cmoyiu4yd000zf917acq9twtr, 2026-05-09).
describe('classifyDiffAgainstPlan — plan met pseudo-paths', () => {
  it('negeert `data-debug-label="..."` als pseudo-pad en classificeert ALIGNED', () => {
    const plan = [
      'Verwijder alle voorkomens van `data-debug-label="..."` uit:',
      '',
      '- `app/components/shared/status-bar.tsx`',
      '- `app/components/shared/header.tsx`',
    ].join('\n')
    const diff = makeDiff([
      'app/components/shared/status-bar.tsx',
      'app/components/shared/header.tsx',
    ])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('ALIGNED')
  })

  it('negeert ellipsis-tokens (drie of meer dots) als pad', () => {
    const plan = 'Refactor `foo(...)` naar `bar()`. Files: `src/a.ts`.'
    const diff = makeDiff(['src/a.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('ALIGNED')
  })

  it('negeert tokens met operators/quotes als pad', () => {
    const plan = 'Wijzig `props={x: 1}` en `useState<string>()` in `src/c.tsx`.'
    const diff = makeDiff(['src/c.tsx'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('ALIGNED')
  })

  it('accepteert package.json en andere extension-only paths', () => {
    const plan = 'Update `package.json` en `tsconfig.json`.'
    const diff = makeDiff(['package.json', 'tsconfig.json'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('ALIGNED')
  })

  it('blijft PARTIAL retourneren wanneer een echt plan-pad ontbreekt', () => {
    const plan = 'Wijzig `src/foo.ts` en `src/bar.ts`. Verwijder `data-x="..."`.'
    const diff = makeDiff(['src/foo.ts'])
    const r = classifyDiffAgainstPlan({ diff, plan })
    expect(r.result).toBe('PARTIAL')
    expect(r.reasoning).toMatch(/bar\.ts/)
  })
})
