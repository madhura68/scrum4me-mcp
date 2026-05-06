import { describe, it, expect } from 'vitest'
import { classifyDiffAgainstPlan } from '../../src/verify/classify.js'

describe('classify — delete-only commits (PBI-47 C5)', () => {
  it('returns ALIGNED when the deleted path is in the plan', () => {
    const diff = `diff --git a/app/todos/page.tsx b/app/todos/page.tsx
deleted file mode 100644
index 1234567..0000000
--- a/app/todos/page.tsx
+++ /dev/null
@@ -1,3 +0,0 @@
-export default function TodosPage() {
-  return null
-}`

    const plan = '- Verwijder `app/todos/page.tsx`\n- Verwijder gerelateerde imports'

    const result = classifyDiffAgainstPlan({ diff, plan })
    expect(result.result).toBe('ALIGNED')
  })

  it('returns ALIGNED for multi-file delete-only when both paths in plan', () => {
    const diff = `diff --git a/app/todos/page.tsx b/app/todos/page.tsx
deleted file mode 100644
--- a/app/todos/page.tsx
+++ /dev/null
@@ -1,2 +0,0 @@
-line 1
-line 2
diff --git a/components/todo-list.tsx b/components/todo-list.tsx
deleted file mode 100644
--- a/components/todo-list.tsx
+++ /dev/null
@@ -1,1 +0,0 @@
-line`

    const plan = '- `app/todos/page.tsx`\n- `components/todo-list.tsx`'
    const result = classifyDiffAgainstPlan({ diff, plan })
    expect(result.result).toBe('ALIGNED')
  })

  it('returns PARTIAL when only some plan deletes appear in the diff', () => {
    const diff = `diff --git a/a.ts b/a.ts
deleted file mode 100644
--- a/a.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-x`

    const plan = '- `a.ts`\n- `b.ts`' // b.ts missing
    const result = classifyDiffAgainstPlan({ diff, plan })
    expect(result.result).toBe('PARTIAL')
  })

  it('returns EMPTY for a no-op diff', () => {
    const result = classifyDiffAgainstPlan({ diff: '', plan: 'irrelevant' })
    expect(result.result).toBe('EMPTY')
  })
})
