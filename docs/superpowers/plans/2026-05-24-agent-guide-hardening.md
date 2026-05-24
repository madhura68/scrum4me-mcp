# Agent Guide Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the agent-guide reaches sprint sub-agents and keep ProductDoc metadata out of binding guide text.

**Architecture:** Keep the existing delivery model: `get_agent_guide` remains the canonical MCP tool, and `resolveAgentGuide()` remains the only merge point. Harden two edges: the sprint prompt must pass `guide_md` into delegated `Agent` work, and the resolver should append only the ProductDoc body, not YAML frontmatter.

**Tech Stack:** TypeScript, Vitest, Prisma-backed ProductDocs, Markdown kind-prompts.

---

## Files

- Modify: `src/prompts/sprint/implementation.md`
- Modify: `__tests__/kind-prompts.test.ts`
- Modify: `src/lib/agent-guide.ts`
- Modify: `__tests__/lib/agent-guide.test.ts`

## Task 1: Pass `guide_md` Into Sprint Sub-Agents

**Files:**
- Modify: `src/prompts/sprint/implementation.md:46-52`
- Modify: `__tests__/kind-prompts.test.ts:85-95`

- [ ] **Step 1: Add the failing prompt invariant test**

Append this assertion to the existing `SPRINT instructs Agent sub-agent dispatch and keeps the verify-gate in the main session` test in `__tests__/kind-prompts.test.ts`:

```ts
expect(s).toMatch(/guide_md[\s\S]*sub-agent|sub-agent[\s\S]*guide_md/)
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
npx vitest run __tests__/kind-prompts.test.ts
```

Expected before implementation: FAIL because the sprint prompt mentions `get_agent_guide`, but does not require `guide_md` to be passed to the delegated sub-agent.

- [ ] **Step 3: Update the sprint delegation instruction**

Replace `src/prompts/sprint/implementation.md` lines 46-53 with:

```md
2. **Delegeer naar een sub-agent** (de `Agent`-tool). Geef een zelfstandige opdracht met
   het `plan_snapshot` van deze execution, de relevante `task`/`story`/`pbi`-context uit
   de payload, het `worktree_path`, en de volledige `guide_md` uit de agent-guide. Instrueer
   de sub-agent om: de meegegeven `guide_md` als bindend te volgen, uitsluitend in
   `worktree_path` te werken, per logische laag te committen (`git add -A && git commit`,
   **geen** `git push`), te loggen via `log_implementation` / `log_commit` /
   `log_test_result`, en een **beknopte samenvatting** terug te geven (wat gewijzigd,
   commit-hashes, testuitslagen). Lees zelf geen code-bestanden in — houd dat in de
   sub-agent-context.
```

- [ ] **Step 4: Re-run the prompt test**

Run:

```bash
npx vitest run __tests__/kind-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/sprint/implementation.md __tests__/kind-prompts.test.ts
git commit -m "fix(agent-guide): pass guide into sprint sub-agents"
```

## Task 2: Strip ProductDoc Frontmatter Before Merging

**Files:**
- Modify: `src/lib/agent-guide.ts`
- Modify: `__tests__/lib/agent-guide.test.ts`

- [ ] **Step 1: Add the failing resolver test**

Add this test to `__tests__/lib/agent-guide.test.ts` inside `describe('resolveAgentGuide', ...)`:

```ts
it('appends only the ProductDoc body, not YAML frontmatter', async () => {
  mockProductDocFindFirst.mockResolvedValue({
    slug: 'agent-guide',
    status: 'active',
    content_md: [
      '---',
      'title: Agent guide',
      'status: active',
      '---',
      '',
      'Always run the product smoke test.',
    ].join('\n'),
    updated_at: new Date('2026-05-24T00:00:00Z'),
  })

  const result = await resolveAgentGuide(productWithManual)

  expect(result.guide_md).toContain('Always run the product smoke test.')
  expect(result.guide_md).not.toContain('title: Agent guide')
  expect(result.guide_md).not.toContain('status: active')
})
```

- [ ] **Step 2: Run the focused resolver test and confirm it fails**

Run:

```bash
npx vitest run __tests__/lib/agent-guide.test.ts
```

Expected before implementation: FAIL because `override.content_md` is appended directly.

- [ ] **Step 3: Parse the ProductDoc and append only `body`**

Modify `src/lib/agent-guide.ts`:

```ts
import { parseProductDocMd } from './product-doc-parser.js'
```

Replace the override merge block with:

```ts
if (override) {
  const label = product.code ?? product.name
  const parsed = parseProductDocMd(override.content_md)
  const overrideBody = parsed.ok ? parsed.body.trim() : override.content_md.trim()
  guide_md = `${AGENT_GUIDE_DEFAULT}\n\n---\n\n## Product-specifieke aanvullingen — ${label}\n\n${overrideBody}`
}
```

- [ ] **Step 4: Re-run resolver tests**

Run:

```bash
npx vitest run __tests__/lib/agent-guide.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-guide.ts __tests__/lib/agent-guide.test.ts
git commit -m "fix(agent-guide): strip ProductDoc frontmatter from merged guide"
```

## Task 3: Full Verification

**Files:**
- No code changes.

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: exit 0.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: all test files pass.

- [ ] **Step 4: Verify compiled agent-guide artifacts exist**

```bash
test -f dist/lib/agent-guide-default.js \
  && test -f dist/lib/agent-guide.js \
  && test -f dist/tools/get-agent-guide.js \
  && test -f dist/instructions.js
```

Expected: exit 0.

- [ ] **Step 5: Commit verification notes if docs are updated**

Only if implementation notes or review docs are updated:

```bash
git add docs/superpowers
git commit -m "docs(agent-guide): add hardening review and plan"
```

## Self-Review Checklist

- [ ] Sprint sub-agent prompt explicitly passes `guide_md`.
- [ ] Product override body appears in `guide_md`; YAML frontmatter does not.
- [ ] Existing status/folder gating remains intact.
- [ ] `get_agent_guide` remains registered in `registerSharedTools()`.
- [ ] `TASK_IMPLEMENTATION` and `SPRINT_IMPLEMENTATION` still allow `mcp__scrum4me__get_agent_guide`.
- [ ] `npm run typecheck`, `npm run build`, and `npm test` pass.
