# Phase 2 — PR-code-review op codex — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Een codex-fleet-worker reviewt een Forgejo PR als een first-class `PR_REVIEW`-job (manual-enqueue, advisory) en post autonoom een Forgejo review-state terug.

**Architecture:** Nieuw `ClaudeJobKind` (`PR_REVIEW`); de mcp bouwt een payload met diff + PR-meta + gekoppeld plan, een codex-portable prompt velt het verdict, en een `post_pr_review`-sink post `APPROVED`/`REQUEST_CHANGES`/`COMMENT` via de bestaande Forgejo-client. Puur API/DB — geen worktree. Hergebruikt de Phase-0/1-substraat (runtime-claim-routing, capability-gate, runtime-bewuste promptselectie, snapshot-override).

**Tech Stack:** TypeScript, Prisma 7, vitest; Forgejo REST (`src/git/forgejo-rest.ts`); scrum4me-shared (enum, designated migrator = scrum4me-web); scrum4me-docker runner; Next.js workers-UI.

**Spec:** `docs/superpowers/specs/2026-06-09-codex-pr-review-phase2-design.md` (codex round-2 GO + 154 GO).

---

## Cross-repo gating (lees eerst)

- **Volgorde is hard:** shared-PR (Task 1) **merget eerst** (door de gebruiker geautoriseerd), pas dán bump je de submodule in de andere repo's. Géén gestackte PR's (een mcp-submodule-bump naar een nog-niet-gemergede shared-branch breekt bij squash-merge).
- **mcp-werk gebeurt in de bestaande worktree** `/Users/janpetervisser/Development/scrum4me-mcp-codex-pr-review` (branch `feat/codex-pr-review-phase2`, off `origin/main` `eeee8c7`). Spec + dit plan staan daar al.
- **shared/docker/workers** krijgen elk een eigen isolated worktree (via `superpowers:using-git-worktrees`) wanneer hun taak begint.
- **Merges zijn user-gated** (Forgejo-PR-acties via de API, niet `gh`/`tea`). **Elke PR + diff gaat ter codex-review via de s4m-queue** (`push --to mac:codex --type review_request`) vóór merge.
- **Commit-trailer:** elke commit eindigt op `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

**scrum4me-shared**
- Modify: `prisma/schema.prisma` — `ClaudeJobKind` enum: `PR_REVIEW` toevoegen (canonieke bron; consumers bumpen + `prisma generate`).

**scrum4me-mcp** (worktree `scrum4me-mcp-codex-pr-review`)
- Create: `src/prompts/pr/review.codex.md` — codex-portable PR-review-prompt (autonoom verdict).
- Create: `src/prompts/pr/review.md` — dunne Claude-fallback (voorkomt leeg-draaien bij claude-enqueue).
- Modify: `src/lib/kind-prompts.ts` — `KIND_TO_PROMPT_PATH.PR_REVIEW` + `RUNTIME_PROMPT_OVERRIDES.CODEX.PR_REVIEW`.
- Modify: `src/git/pr.ts` — `fetchPrDiff` + `postPullRequestReview`.
- Create: `src/lib/pr-linked-plan.ts` — `resolvePrLinkedPlan(job)`: implementerende-job/PBI/no-link resolutie (§7).
- Create: `src/tools/post-pr-review.ts` — sink-tool `post_pr_review`.
- Modify: `src/register.ts` — registreer `post_pr_review`.
- Modify: `src/tools/wait-for-job.ts` — `CLAIMABLE_STANDALONE_KINDS` += `PR_REVIEW`; PR_REVIEW-tak in `getFullJobContext` vóór de MANUAL-branch (`:775`).
- Test: `__tests__/lib/kind-prompts.test.ts`, `__tests__/git/pr-review-helpers.test.ts`, `__tests__/lib/pr-linked-plan.test.ts`, `__tests__/tools/post-pr-review.test.ts`, `__tests__/tools/wait-for-job-pr-review.test.ts`.

**scrum4me-docker** (eigen worktree)
- Modify: `bin/run-one-job.ts` — PR_REVIEW slaat worktree-attach over (read-only).

**scrum4me-workers** (eigen worktree)
- Modify: `lib/manual-job-draft.ts` — `MANUAL_JOB_KINDS` += `PR_REVIEW`; `ManualJobDraftInput.prUrl`; `ManualJobLaunchPreview.context.prUrl`; `buildManualJobLaunchPreview` + zod-parseveld.
- Modify: `lib/manual-jobs/validation.ts` — **eigen** `MANUAL_JOB_KINDS` += `PR_REVIEW`; `ManualJobValidationInput.prUrl`; PR_REVIEW-veldregels (de echte validator achter save-draft).
- Modify: `lib/manual-jobs/templates.ts` — `pr-review`-template + kind-union.
- Modify: `components/jobs/manual-job-draft-editor.tsx` — `prUrl` uit `inputValues.pr_url` in de draft-useMemo.
- Modify: `actions/manual-jobs.ts` — `readPrUrlFromLaunchPreview` + verplicht voor PR_REVIEW + `pr_url` → `ClaudeJob` op create (snapshot-override hergebruikt).
- Test: `__tests__/actions/manual-jobs.test.ts`, `__tests__/actions/manual-job-drafts.test.ts` (save-draft persisteert `context.prUrl`), lib-tests voor `buildManualJobLaunchPreview` + `validateManualJobInput`.

---

### Task 1: scrum4me-shared — `ClaudeJobKind += PR_REVIEW`

**Files:**
- Modify: `scrum4me-shared/prisma/schema.prisma` (de `enum ClaudeJobKind { … }`-blok)

- [ ] **Step 1: Maak een isolated worktree voor scrum4me-shared**

Run (vanuit `/Users/janpetervisser/Development/scrum4me-shared`):
```bash
git fetch origin --quiet
git worktree add /Users/janpetervisser/Development/scrum4me-shared-pr-review -b feat/pr-review-kind origin/main
```
Expected: nieuwe worktree op branch `feat/pr-review-kind`.

- [ ] **Step 2: Voeg de enum-waarde toe**

In `scrum4me-shared-pr-review/prisma/schema.prisma`, zoek `enum ClaudeJobKind {` en voeg `PR_REVIEW` toe als laatste waarde:
```prisma
enum ClaudeJobKind {
  TASK_IMPLEMENTATION
  IDEA_GRILL
  IDEA_MAKE_PLAN
  IDEA_REVIEW_PLAN
  PLAN_CHAT
  SPRINT_IMPLEMENTATION
  PR_REVIEW
}
```
Als scrum4me-shared een `lib/`-mirror of TS-enum heeft (bv. een gegenereerde of handmatige `ClaudeJobKind`-union), spiegel `PR_REVIEW` daar ook. (Verifieer met `grep -rn "SPRINT_IMPLEMENTATION" scrum4me-shared-pr-review/` welke bestanden de enum noemen.)

- [ ] **Step 3: Commit**

```bash
cd /Users/janpetervisser/Development/scrum4me-shared-pr-review
git add -A
git commit -m "feat(schema): add PR_REVIEW to ClaudeJobKind" -m "Phase 2 codex PR-code-review: nieuw job-kind voor first-class PR-reviews. Enum-add is data-safe (geen backfill). Migratie draait in scrum4me-web." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin feat/pr-review-kind
```

- [ ] **Step 4: Open de PR + codex-review (s4m-queue) + GATE: user-merge**

Open de PR via de Forgejo-API (curl `--config` met de token, niet in argv). Stuur 'm ter review naar `mac:codex`. **Stop hier voor user-geautoriseerde merge.** Na merge: ga naar Step 5.

- [ ] **Step 5: Bump de submodule in de mcp-worktree + regenereer**

```bash
cd /Users/janpetervisser/Development/scrum4me-mcp-codex-pr-review
git submodule update --init vendor/scrum4me-shared
cd vendor/scrum4me-shared && git fetch origin && git checkout origin/main && cd ../..
npm install   # postinstall = gen-schema + prisma generate → PR_REVIEW in @prisma/client
```

- [ ] **Step 6: Verifieer dat PR_REVIEW in de prisma-client zit**

Run:
```bash
cd /Users/janpetervisser/Development/scrum4me-mcp-codex-pr-review
node -e "console.log(require('@prisma/client').ClaudeJobKind.PR_REVIEW)"
```
Expected: print `PR_REVIEW`. Commit de submodule-bump:
```bash
git add vendor/scrum4me-shared && git commit -m "chore(mcp): bump scrum4me-shared submodule (PR_REVIEW kind)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: mcp — kind-prompts PR_REVIEW-selectie + de twee prompt-bestanden

**Files:**
- Create: `src/prompts/pr/review.codex.md`
- Create: `src/prompts/pr/review.md`
- Modify: `src/lib/kind-prompts.ts:25-40`
- Test: `__tests__/lib/kind-prompts.test.ts`

- [ ] **Step 1: Schrijf de falende test**

In `__tests__/lib/kind-prompts.test.ts`, voeg toe (mirror de bestaande Phase-1-cases in dit bestand):
```ts
import { describe, it, expect } from 'vitest'
import { getKindPromptText } from '../../src/lib/kind-prompts.js'

describe('getKindPromptText — PR_REVIEW', () => {
  it('(PR_REVIEW, CODEX) → codex-portable prompt zonder Claude-toolnamen', () => {
    const text = getKindPromptText('PR_REVIEW', 'CODEX')
    expect(text).toContain('post_pr_review')
    expect(text).not.toContain('ask_user_question')
    expect(text).not.toMatch(/\bGlob\b|\bGrep\b/)
  })
  it('(PR_REVIEW, CLAUDE) → niet-leeg Claude-fallback-pad', () => {
    const text = getKindPromptText('PR_REVIEW', 'CLAUDE')
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toEqual(getKindPromptText('PR_REVIEW', 'CODEX'))
  })
  it('default-runtime = CLAUDE', () => {
    expect(getKindPromptText('PR_REVIEW')).toEqual(getKindPromptText('PR_REVIEW', 'CLAUDE'))
  })
})
```

- [ ] **Step 2: Run de test — moet falen**

Run: `npx vitest run __tests__/lib/kind-prompts.test.ts`
Expected: FAIL (PR_REVIEW niet in de maps; prompt-bestanden bestaan niet → `loadPrompt` throws / lege string).

- [ ] **Step 3: Maak `src/prompts/pr/review.codex.md`**

```markdown
Je bent een onafhankelijke code-reviewer (runtime: CODEX). Je beoordeelt één Forgejo pull-request en legt autonoom een verdict vast. Je vraagt NOOIT iets aan een mens.

## Invoer
Lees het JSON-bestand op $PAYLOAD_PATH. Velden:
- `pr`: { url, owner, repo, index, title, base_ref, head_sha }
- `pr_diff`: de unified diff van de PR (kan groot zijn).
- `linked_plan`: { source, plan_md?, acceptance_criteria?, plan_snapshot? } of null.
- `instruction`: vrije review-instructie van de aanvrager (kan leeg zijn).
- `doc_index`: index van product-docs; lees relevante via mcp__scrum4me__get_product_doc / mcp__scrum4me__search_product_docs.

## Taak
Beoordeel de diff op: codekwaliteit, architectuur-/patroon-conformiteit (tegen de product-docs), tests, en docs. Als `linked_plan` aanwezig is, toets ook plan-conformiteit: implementeert de diff het plan + de acceptatiecriteria correct en volledig?

## Verdict (autonoom)
Bepaal `event`:
- `APPROVED` — geen blokkerende/error-severity findings, en (indien gekoppeld) plan-conform.
- `REQUEST_CHANGES` — minstens één blokkerende finding.
- `COMMENT` — anders (kleine opmerkingen, of twijfel).

Safe-default: bij twijfel, een lege/ontbrekende diff, of een niet-resolvebare PR kies je NOOIT `APPROVED` — kies `COMMENT` of `REQUEST_CHANGES` met reden.

## Body (samenvattende markdown)
Schrijf één review-body:
- Kop met het verdict.
- Een findings-lijst; elke finding: severity + `bestand:regel` (in tekst) + korte uitleg.
- Als `linked_plan` ontbrak: zet expliciet "geen gekoppeld plan gevonden — beoordeeld op codekwaliteit + product-standaarden."
Geen inline-comments.

## Afsluiten
1. Roep `mcp__scrum4me__post_pr_review({ job_id: <pr.job_id of payload.job_id>, pr_url: <pr.url>, event: <APPROVED|REQUEST_CHANGES|COMMENT>, body: <de markdown-body>, commit_id: <pr.head_sha indien aanwezig>, review_log: { findings: [...], verdict: <event> } })`.
   - Faalt deze call (Forgejo-fout), roep dan `mcp__scrum4me__update_job_status({ job_id, status: 'failed', error: 'post_pr_review_failed' })` en stop. Post NOOIT een vals "done".
2. Bij succes: `mcp__scrum4me__update_job_status({ job_id, status: 'done', summary: <event + 1-regel-samenvatting> })`.
```

- [ ] **Step 4: Maak `src/prompts/pr/review.md` (dunne Claude-fallback)**

```markdown
Je beoordeelt één Forgejo pull-request en legt autonoom een verdict vast.

Lees $PAYLOAD_PATH ({ pr, pr_diff, linked_plan, instruction, doc_index }). Beoordeel de diff op codekwaliteit, architectuur-conformiteit (via de product-docs), tests, docs, en — indien `linked_plan` aanwezig — plan-conformiteit.

Bepaal `event` (APPROVED / REQUEST_CHANGES / COMMENT); kies bij twijfel of lege diff nooit APPROVED. Schrijf een samenvattende markdown-body (verdict + findings met bestand:regel). Geen inline-comments.

Roep dan `post_pr_review({ job_id, pr_url, event, body, commit_id, review_log })`; faalt die, roep `update_job_status({ job_id, status: 'failed', error: 'post_pr_review_failed' })` en stop. Bij succes `update_job_status({ job_id, status: 'done', summary })`.
```

- [ ] **Step 5: Registreer de maps in `src/lib/kind-prompts.ts`**

Voeg `PR_REVIEW` toe aan `KIND_TO_PROMPT_PATH` (na `PLAN_CHAT`):
```ts
const KIND_TO_PROMPT_PATH: Partial<Record<ClaudeJobKind, string>> = {
  IDEA_GRILL: 'idea/grill.md',
  IDEA_MAKE_PLAN: 'idea/make-plan.md',
  IDEA_REVIEW_PLAN: 'idea/review-plan.md',
  TASK_IMPLEMENTATION: 'task/implementation.md',
  SPRINT_IMPLEMENTATION: 'sprint/implementation.md',
  PLAN_CHAT: 'plan-chat/chat.md',
  PR_REVIEW: 'pr/review.md',
}
```
En de codex-override:
```ts
const RUNTIME_PROMPT_OVERRIDES: Partial<Record<WorkerRuntime, Partial<Record<ClaudeJobKind, string>>>> = {
  CODEX: {
    IDEA_REVIEW_PLAN: 'idea/review-plan.codex.md',
    PR_REVIEW: 'pr/review.codex.md',
  },
}
```

- [ ] **Step 6: Run de test — moet slagen**

Run: `npx vitest run __tests__/lib/kind-prompts.test.ts`
Expected: PASS (alle cases, incl. de Phase-1-cases).

- [ ] **Step 7: Commit**

```bash
git add src/prompts/pr/ src/lib/kind-prompts.ts __tests__/lib/kind-prompts.test.ts
git commit -m "feat(mcp): PR_REVIEW prompt-selectie + codex/claude prompts" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: mcp — Forgejo-helpers `fetchPrDiff` + `postPullRequestReview`

**Files:**
- Modify: `src/git/pr.ts` (na `listPullRequestFiles`, ~`:333`)
- Test: `__tests__/git/pr-review-helpers.test.ts`

**Context:** `pr.ts` gebruikt `parseForgejoPrUrl` + `callForgejo` + een interne `repoPath(owner, repo)`-helper, en helpers retourneren `T | { error: string }`. `forgejoFetch(pathOrUrl, init)` geeft de raw `Response`; `callForgejo` parset JSON. De `.diff` is text → gebruik `forgejoFetch`, niet `callForgejo`.

- [ ] **Step 1: Schrijf de falende test**

`__tests__/git/pr-review-helpers.test.ts` (mirror de mock-stijl van de bestaande `pr.ts`-tests; mock `../../src/git/forgejo-rest.js`):
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/git/forgejo-rest.js', async (orig) => {
  const actual = await orig<typeof import('../../src/git/forgejo-rest.js')>()
  return {
    ...actual,
    forgejoFetch: vi.fn(),
    callForgejo: vi.fn(),
    requireToken: vi.fn(() => 'tok'),
  }
})

import { forgejoFetch, callForgejo } from '../../src/git/forgejo-rest.js'
import { fetchPrDiff, postPullRequestReview } from '../../src/git/pr.js'

const PR = 'https://git.jp-visser.nl/janpeter/scrum4me-mcp/pulls/42'

beforeEach(() => { vi.clearAllMocks() })

describe('fetchPrDiff', () => {
  it('haalt de unified diff via de .diff-endpoint met forgejoFetch', async () => {
    vi.mocked(forgejoFetch).mockResolvedValue(
      new Response('diff --git a b', { status: 200 }),
    )
    const out = await fetchPrDiff({ prUrl: PR })
    expect(out).toContain('diff --git')
    const calledPath = vi.mocked(forgejoFetch).mock.calls[0][0] as string
    expect(calledPath).toContain('/pulls/42.diff')
  })
  it('non-2xx → { error }', async () => {
    vi.mocked(forgejoFetch).mockResolvedValue(new Response('nope', { status: 404 }))
    const out = await fetchPrDiff({ prUrl: PR })
    expect(out).toHaveProperty('error')
  })
})

describe('postPullRequestReview', () => {
  it('POST /pulls/{index}/reviews met event + body (write)', async () => {
    vi.mocked(callForgejo).mockResolvedValue({ id: 7 })
    const out = await postPullRequestReview({ prUrl: PR, event: 'REQUEST_CHANGES', body: 'x' })
    expect(out).toEqual({ ok: true, reviewId: 7 })
    const [path, init] = vi.mocked(callForgejo).mock.calls[0] as [string, any]
    expect(path).toContain('/pulls/42/reviews')
    expect(init.method).toBe('POST')
    expect(init.write).toBe(true)
    expect(init.json).toMatchObject({ event: 'REQUEST_CHANGES', body: 'x' })
  })
  it('Forgejo-fout → { error }', async () => {
    vi.mocked(callForgejo).mockRejectedValue(new Error('boom'))
    const out = await postPullRequestReview({ prUrl: PR, event: 'COMMENT', body: 'x' })
    expect(out).toHaveProperty('error')
  })
})
```

- [ ] **Step 2: Run de test — moet falen**

Run: `npx vitest run __tests__/git/pr-review-helpers.test.ts`
Expected: FAIL (`fetchPrDiff`/`postPullRequestReview` bestaan niet).

- [ ] **Step 3: Implementeer de helpers in `src/git/pr.ts`**

Voeg toe na `listPullRequestFiles` (gebruik de bestaande imports `parseForgejoPrUrl`, `callForgejo`, `forgejoFetch`, en de interne `repoPath`):
```ts
// =========================================================================
// fetchPrDiff — Phase 2: unified diff van een PR via de .diff-endpoint.
// .diff is text/plain → forgejoFetch (callForgejo zou JSON parsen).
// =========================================================================
export async function fetchPrDiff(opts: {
  prUrl: string
}): Promise<string | { error: string }> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return { error: `fetchPrDiff: ${(err as Error).message.slice(0, 300)}` }
  }
  try {
    const res = await forgejoFetch(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}.diff`,
      { host: prRef.host },
    )
    if (!res.ok) {
      return { error: `Forgejo pr-diff failed: ${res.status}` }
    }
    return await res.text()
  } catch (err) {
    return { error: `Forgejo pr-diff failed: ${(err as Error).message.slice(0, 300)}` }
  }
}

// =========================================================================
// postPullRequestReview — Phase 2: post een review-state op een PR.
// =========================================================================
export async function postPullRequestReview(opts: {
  prUrl: string
  event: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT'
  body: string
  commitId?: string
}): Promise<{ ok: true; reviewId?: number } | { error: string }> {
  let prRef
  try {
    prRef = parseForgejoPrUrl(opts.prUrl)
  } catch (err) {
    return { error: `postPullRequestReview: ${(err as Error).message.slice(0, 300)}` }
  }
  try {
    const review = await callForgejo<{ id?: number }>(
      `${repoPath(prRef.owner, prRef.repo)}/pulls/${prRef.index}/reviews`,
      {
        method: 'POST',
        write: true,
        host: prRef.host,
        json: { event: opts.event, body: opts.body, commit_id: opts.commitId },
      },
    )
    return { ok: true, reviewId: review?.id }
  } catch (err) {
    return { error: `Forgejo pr-review-post failed: ${(err as Error).message.slice(0, 300)}` }
  }
}
```
> NB: verifieer dat `repoPath` en `forgejoFetch` al in `pr.ts` geïmporteerd zijn; voeg ze anders toe aan de bestaande import uit `./forgejo-rest.js`. Bevestig de `event`-enum-strings (`APPROVED`/`REQUEST_CHANGES`/`COMMENT`) tegen de live swagger (`fetchSwagger`) — een foute waarde geeft 422; de canary (Task 10) vangt dit.

- [ ] **Step 4: Run de test — moet slagen**

Run: `npx vitest run __tests__/git/pr-review-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git/pr.ts __tests__/git/pr-review-helpers.test.ts
git commit -m "feat(mcp): Forgejo fetchPrDiff + postPullRequestReview helpers" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: mcp — `post_pr_review` sink-tool

**Files:**
- Create: `src/tools/post-pr-review.ts`
- Modify: `src/register.ts` (registreer de tool, mirror `registerUpdateIdeaPlanReviewedTool`)
- Test: `__tests__/tools/post-pr-review.test.ts`

**Context:** Model = `src/tools/update-idea-plan-reviewed.ts` (`inputSchema` zod + `handle…` met `withToolErrors` + `requireWriteAccess` + `toolJson`/`toolError`, en een `register…Tool(server)`). De sink post via `postPullRequestReview` (Task 3) en schrijft een verdict-trace naar `ClaudeJob.summary`. **Een Forgejo-fout faalt de tool** (geen stille review-verlies).

- [ ] **Step 1: Schrijf de falende test**

`__tests__/tools/post-pr-review.test.ts` (mirror de mock-setup van bestaande tool-tests: mock `../../src/prisma.js`, `../../src/auth.js`, en `../../src/git/pr.js`):
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/auth.js', () => ({
  requireWriteAccess: vi.fn(async () => ({ userId: 'u1' })),
}))
vi.mock('../../src/git/pr.js', () => ({
  postPullRequestReview: vi.fn(),
}))
vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn(), update: vi.fn(async () => ({})) } },
}))

import { postPullRequestReview } from '../../src/git/pr.js'
import { prisma } from '../../src/prisma.js'
import { handlePostPrReview } from '../../src/tools/post-pr-review.js'

const PR = 'https://git.jp-visser.nl/o/r/pulls/9'
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({ id: 'job1', user_id: 'u1', pr_url: PR, kind: 'PR_REVIEW' } as any)
})

describe('post_pr_review', () => {
  it('post de review + schrijft summary-trace', async () => {
    vi.mocked(postPullRequestReview).mockResolvedValue({ ok: true, reviewId: 3 })
    const res = await handlePostPrReview({ job_id: 'job1', pr_url: PR, event: 'APPROVED', body: 'lgtm' })
    expect(postPullRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: PR, event: 'APPROVED', body: 'lgtm' }),
    )
    expect(prisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'job1' } }),
    )
    expect(res.isError).toBeFalsy()
  })
  it('Forgejo-fout → tool faalt (geen valse done)', async () => {
    vi.mocked(postPullRequestReview).mockResolvedValue({ error: 'boom' })
    const res = await handlePostPrReview({ job_id: 'job1', pr_url: PR, event: 'COMMENT', body: 'x' })
    expect(res.isError).toBe(true)
    expect(prisma.claudeJob.update).not.toHaveBeenCalled()
  })
  it('niet-PR_REVIEW job → error (sink is geen vrije post-API)', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({ id: 'job1', user_id: 'u1', pr_url: PR, kind: 'IDEA_REVIEW_PLAN' } as any)
    const res = await handlePostPrReview({ job_id: 'job1', pr_url: PR, event: 'COMMENT', body: 'x' })
    expect(res.isError).toBe(true)
    expect(postPullRequestReview).not.toHaveBeenCalled()
  })
  it('pr_url ≠ job.pr_url → error (geen cross-PR posting)', async () => {
    const res = await handlePostPrReview({ job_id: 'job1', pr_url: 'https://git.jp-visser.nl/o/r/pulls/999', event: 'COMMENT', body: 'x' })
    expect(res.isError).toBe(true)
    expect(postPullRequestReview).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run de test — moet falen**

Run: `npx vitest run __tests__/tools/post-pr-review.test.ts`
Expected: FAIL (`handlePostPrReview` bestaat niet).

- [ ] **Step 3: Implementeer `src/tools/post-pr-review.ts`**

```ts
// MCP-tool: post een Forgejo PR-review-state na een PR_REVIEW-job en schrijft
// een verdict-trace naar ClaudeJob.summary. Een Forgejo-post-fout faalt de
// tool (geen stille review-verlies). Model: update-idea-plan-reviewed.ts.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { postPullRequestReview } from '../git/pr.js'

export const inputSchema = z.object({
  job_id: z.string().min(1),
  pr_url: z.string().min(1),
  event: z.enum(['APPROVED', 'REQUEST_CHANGES', 'COMMENT'] as const),
  body: z.string().min(1),
  commit_id: z.string().optional(),
  review_log: z.object({}).passthrough().optional(),
})

export async function handlePostPrReview(
  { job_id, pr_url, event, body, commit_id }: z.infer<typeof inputSchema>,
) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const job = await prisma.claudeJob.findUnique({
      where: { id: job_id },
      select: { id: true, user_id: true, pr_url: true, kind: true },
    })
    if (!job || job.user_id !== auth.userId) {
      return toolError('Job not found')
    }
    // De job is de autoriteit (codex plan-review P2): alleen een PR_REVIEW-job
    // met een opgeslagen pr_url mag posten, en alléén naar díe PR.
    if (job.kind !== 'PR_REVIEW') {
      return toolError('Job is not a PR_REVIEW job')
    }
    if (!job.pr_url) {
      return toolError('Job has no pr_url')
    }
    if (pr_url !== job.pr_url) {
      return toolError(`pr_url mismatch: job is bound to ${job.pr_url}`)
    }

    const posted = await postPullRequestReview({ prUrl: job.pr_url, event, body, commitId: commit_id })
    if ('error' in posted) {
      // Faalt bewust: geen stille review-verlies, prompt faalt de job.
      return toolError(`post_pr_review failed: ${posted.error}`)
    }

    await prisma.claudeJob.update({
      where: { id: job_id },
      data: { summary: `PR review ${event}: ${body.slice(0, 280)}` },
    })

    return toolJson({ ok: true, event, review_id: posted.reviewId ?? null })
  })
}

export function registerPostPrReviewTool(server: McpServer) {
  server.registerTool(
    'post_pr_review',
    {
      title: 'Post a PR review verdict',
      description:
        'Post a Forgejo PR review (event APPROVED/REQUEST_CHANGES/COMMENT) for a ' +
        'PR_REVIEW job and record a verdict-trace on the job. A Forgejo failure ' +
        'fails the tool (never a silent success). Forbidden for demo accounts.',
      inputSchema,
    },
    handlePostPrReview,
  )
}
```
> NB: verifieer de exacte vorm van `toolError`/`toolJson`/`withToolErrors` en de `requireWriteAccess`-returnshape tegen `update-idea-plan-reviewed.ts`; pas import-namen aan indien de helpers daar anders heten.

- [ ] **Step 4: Registreer de tool in `src/register.ts`**

Zoek waar `registerUpdateIdeaPlanReviewedTool(server)` wordt aangeroepen en voeg ernaast toe:
```ts
import { registerPostPrReviewTool } from './tools/post-pr-review.js'
// …in de register-functie, naast de andere register…Tool(server)-calls:
registerPostPrReviewTool(server)
```

- [ ] **Step 5: Run de test + typecheck — moeten slagen**

Run: `npx vitest run __tests__/tools/post-pr-review.test.ts && npx tsc --noEmit`
Expected: PASS + 0 type-fouten.

- [ ] **Step 6: Commit**

```bash
git add src/tools/post-pr-review.ts src/register.ts __tests__/tools/post-pr-review.test.ts
git commit -m "feat(mcp): post_pr_review sink-tool" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: mcp — `resolvePrLinkedPlan` helper (§7)

**Files:**
- Create: `src/lib/pr-linked-plan.ts`
- Test: `__tests__/lib/pr-linked-plan.test.ts`

**Context:** Resolutie van het plan/acceptatie dat bij een PR hoort. Sluit de huidige review-job uit (self-match), filter op implementatie-dragers, val terug op PBI, dan op geen-koppeling.

- [ ] **Step 1: Schrijf de falende test**

`__tests__/lib/pr-linked-plan.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findFirstJob = vi.fn()
const findFirstPbi = vi.fn()
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findFirst: (...a: any[]) => findFirstJob(...a) },
    pbi: { findFirst: (...a: any[]) => findFirstPbi(...a) },
  },
}))

import { resolvePrLinkedPlan } from '../../src/lib/pr-linked-plan.js'

const JOB = { id: 'review-job', pr_url: 'https://git.jp-visser.nl/o/r/pulls/9' }
beforeEach(() => { vi.clearAllMocks(); findFirstJob.mockResolvedValue(null); findFirstPbi.mockResolvedValue(null) })

describe('resolvePrLinkedPlan', () => {
  it('sluit de huidige review-job uit in de query', async () => {
    await resolvePrLinkedPlan(JOB as any)
    const where = findFirstJob.mock.calls[0][0].where
    expect(where.id).toEqual({ not: 'review-job' })
    expect(where.pr_url).toBe(JOB.pr_url)
  })
  it('job-pad: task-implementatie met plan_snapshot', async () => {
    findFirstJob.mockResolvedValue({
      id: 'impl', kind: 'TASK_IMPLEMENTATION', plan_snapshot: 'PLAN',
      task: { implementation_plan: 'TP', story: { acceptance_criteria: 'AC' } },
    })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'job', plan_snapshot: 'PLAN', acceptance_criteria: 'AC' })
  })
  it('pbi-fallback via PbiDoc(role=PLAN) → doc_revision.content_md', async () => {
    findFirstPbi.mockResolvedValue({
      id: 'pbi1',
      docs: [{ doc_revision: { content_md: 'PM' } }],
    })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'pbi', plan_md: 'PM' })
  })
  it('pbi zonder PLAN-doc → null (geen bruikbaar plan)', async () => {
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [] })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toBeNull()
  })
  it('no-link wanneer niets matcht → null', async () => {
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toBeNull()
  })
})
```

- [ ] **Step 2: Run de test — moet falen**

Run: `npx vitest run __tests__/lib/pr-linked-plan.test.ts`
Expected: FAIL (`resolvePrLinkedPlan` bestaat niet).

- [ ] **Step 3: Implementeer `src/lib/pr-linked-plan.ts`**

```ts
import { prisma } from '../prisma.js'

export type LinkedPlan = {
  source: 'job' | 'pbi'
  plan_md?: string | null
  acceptance_criteria?: string | null
  plan_snapshot?: string | null
}

/**
 * Resolve het plan/acceptatie dat bij een PR hoort, voor een PR_REVIEW-job.
 * Sluit de huidige review-job uit (self-match op pr_url) en filtert op
 * implementatie-dragers; valt terug op PBI; anders null (review op diff +
 * product-docs).
 */
export async function resolvePrLinkedPlan(
  job: { id: string; pr_url: string | null },
): Promise<LinkedPlan | null> {
  if (!job.pr_url) return null

  const impl = await prisma.claudeJob.findFirst({
    where: {
      pr_url: job.pr_url,
      id: { not: job.id },
      OR: [
        { kind: 'TASK_IMPLEMENTATION', task_id: { not: null } },
        { kind: 'SPRINT_IMPLEMENTATION', sprint_run_id: { not: null } },
      ],
    },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      plan_snapshot: true,
      task: {
        select: {
          implementation_plan: true,
          story: { select: { acceptance_criteria: true } },
        },
      },
    },
  })

  if (impl) {
    const acceptance = impl.task?.story?.acceptance_criteria ?? null
    const planMd = impl.task?.implementation_plan ?? null
    if (impl.plan_snapshot || planMd || acceptance) {
      return {
        source: 'job',
        plan_snapshot: impl.plan_snapshot ?? null,
        plan_md: planMd,
        acceptance_criteria: acceptance,
      }
    }
  }

  // Pbi heeft geen plan_md-kolom (codex plan-review P2); plan-content hangt
  // via PbiDoc(role=PLAN) aan een ProductDocRevision.
  const pbi = await prisma.pbi.findFirst({
    where: { pr_url: job.pr_url },
    select: {
      id: true,
      docs: {
        where: { role: 'PLAN' },
        orderBy: { created_at: 'desc' },
        take: 1,
        select: { doc_revision: { select: { content_md: true } } },
      },
    },
  })
  const pbiPlanMd = pbi?.docs[0]?.doc_revision?.content_md ?? null
  if (pbi && pbiPlanMd) {
    return { source: 'pbi', plan_md: pbiPlanMd }
  }

  return null
}
```
> NB: geverifieerd tegen het schema — `Pbi` heeft GEEN `plan_md`; plan-content loopt via `Pbi.docs` → `PbiDoc` (`role PbiDocRole` = `PLAN|GRILL`) → `doc_revision.content_md`. Verifieer wel `Task.implementation_plan` + `Story.acceptance_criteria` tegen het gebumpte schema; heet een veld anders, pas de `select` aan (de tests pinnen het gedrag, niet de exacte kolom).

- [ ] **Step 4: Run de test — moet slagen**

Run: `npx vitest run __tests__/lib/pr-linked-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pr-linked-plan.ts __tests__/lib/pr-linked-plan.test.ts
git commit -m "feat(mcp): resolvePrLinkedPlan (PR→plan/acceptatie, self-match excl.)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: mcp — `getFullJobContext` PR_REVIEW-tak + `CLAIMABLE_STANDALONE_KINDS`

**Files:**
- Modify: `src/tools/wait-for-job.ts:320` (`CLAIMABLE_STANDALONE_KINDS`) en `:773-775` (insert vóór de MANUAL-branch)
- Test: `__tests__/tools/wait-for-job-pr-review.test.ts`

- [ ] **Step 1: Schrijf de falende test**

`__tests__/tools/wait-for-job-pr-review.test.ts` (mock prisma + de Forgejo-helpers + resolvePrLinkedPlan):
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findUnique = vi.fn()
vi.mock('../../src/prisma.js', () => ({ prisma: { claudeJob: { findUnique: (...a:any[]) => findUnique(...a) } } }))
vi.mock('../../src/git/pr.js', () => ({
  fetchPrDiff: vi.fn(async () => 'diff --git a b'),
  getPullRequestState: vi.fn(async () => ({ state: 'OPEN', title: 'T', baseRefName: 'main', headSha: 'sha1' })),
}))
vi.mock('../../src/lib/pr-linked-plan.js', () => ({ resolvePrLinkedPlan: vi.fn(async () => ({ source: 'job', plan_snapshot: 'P' })) }))
vi.mock('../../src/lib/doc-index.js', () => ({ buildDocIndex: vi.fn(async () => null) }))
// resolveJobConfig stub indien nodig per bestaand harness-patroon.

import { getFullJobContext } from '../../src/tools/wait-for-job.js'

const PR = 'https://git.jp-visser.nl/janpeter/scrum4me-mcp/pulls/42'
beforeEach(() => { vi.clearAllMocks() })

it('MANUAL PR_REVIEW → pr/pr_diff/linked_plan (niet de generieke manual-payload)', async () => {
  findUnique.mockResolvedValue({
    id: 'job1', kind: 'PR_REVIEW', source: 'MANUAL', pr_url: PR,
    product: { id: 'p', name: 'n', repo_url: 'r', definition_of_done: '', preferred_model: null, thinking_budget_default: null, preferred_permission_mode: null },
    manual_drafts: [{ id: 'd', prompt_md: 'review grondig', launch_preview_json: {} }],
    task: null, idea: null,
  })
  const ctx: any = await getFullJobContext('job1')
  expect(ctx.kind).toBe('PR_REVIEW')
  expect(ctx.pr).toMatchObject({ url: PR, index: 42 }) // parseForgejoPrUrl → index: number
  expect(ctx.pr_diff).toContain('diff --git')
  expect(ctx.linked_plan).toMatchObject({ source: 'job' })
  expect(ctx.instruction).toBe('review grondig')
  expect(ctx).not.toHaveProperty('manual_job') // niet de generieke MANUAL-payload
})
```

- [ ] **Step 2: Run de test — moet falen**

Run: `npx vitest run __tests__/tools/wait-for-job-pr-review.test.ts`
Expected: FAIL (PR_REVIEW valt nu in de generieke MANUAL-branch → `manual_job` aanwezig, geen `pr`).

- [ ] **Step 3: Voeg `PR_REVIEW` toe aan `CLAIMABLE_STANDALONE_KINDS` (`:320`)**

```ts
const CLAIMABLE_STANDALONE_KINDS = "('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'PLAN_CHAT', 'PR_REVIEW')"
```

- [ ] **Step 4: Voeg de PR_REVIEW-tak toe vóór de MANUAL-branch**

In `getFullJobContext`, **na** de `docIndex`-setup (`:773`) en **vóór** `if (job.source === 'MANUAL')` (`:775`), insert. Voeg bovenaan het bestand de imports toe (`fetchPrDiff`, `getPullRequestState` uit `../git/pr.js`; `parseForgejoPrUrl` uit `../git/forgejo-rest.js`; `resolvePrLinkedPlan` uit `../lib/pr-linked-plan.js`):
```ts
  if (job.kind === 'PR_REVIEW') {
    if (!job.pr_url) {
      await rollbackClaim(job.id)
      return null
    }
    let prRef
    try {
      prRef = parseForgejoPrUrl(job.pr_url)
    } catch {
      await rollbackClaim(job.id)
      return null
    }
    const draft = job.manual_drafts[0] ?? null
    const instruction = draft?.prompt_md ?? ''
    const diff = await fetchPrDiff({ prUrl: job.pr_url })
    const prInfo = await getPullRequestState({ prUrl: job.pr_url })
    const linkedPlan = await resolvePrLinkedPlan({ id: job.id, pr_url: job.pr_url })

    return {
      job_id: job.id,
      kind: 'PR_REVIEW',
      source: job.source,
      status: 'claimed',
      config,
      doc_index: docIndex,
      pr: {
        url: job.pr_url,
        owner: prRef.owner,
        repo: prRef.repo,
        index: prRef.index,
        host: prRef.host,
        title: 'error' in prInfo ? null : prInfo.title,
        base_ref: 'error' in prInfo ? null : prInfo.baseRefName,
        head_sha: 'error' in prInfo ? null : prInfo.headSha,
      },
      pr_diff: typeof diff === 'string' ? diff : null,
      linked_plan: linkedPlan,
      instruction,
      product: {
        id: job.product.id,
        name: job.product.name,
        repo_url: job.product.repo_url,
        definition_of_done: job.product.definition_of_done,
      },
      repo_url: job.product.repo_url,
      prompt_text: '', // runner is gezaghebbend (getKindPromptText(kind, runtime))
    }
  }
```

- [ ] **Step 5: Run de test — moet slagen**

Run: `npx vitest run __tests__/tools/wait-for-job-pr-review.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/wait-for-job.ts __tests__/tools/wait-for-job-pr-review.test.ts
git commit -m "feat(mcp): PR_REVIEW getFullJobContext-tak (vóór MANUAL) + CLAIMABLE_STANDALONE" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: mcp — volledige verify + PR + codex-review + merge (GATE)

**Files:** geen nieuwe; integratie-gate.

- [ ] **Step 1: Volledige suite + typecheck**

Run:
```bash
cd /Users/janpetervisser/Development/scrum4me-mcp-codex-pr-review
npx vitest run && npx tsc --noEmit
```
Expected: hele suite groen, 0 type-fouten. Bij rood: root-cause fixen in de geraakte bestanden, niet de test omzeilen.

- [ ] **Step 2: Push + open de mcp-PR**

```bash
git push
```
Open de PR (`feat/codex-pr-review-phase2` → `main`) via de Forgejo-API (curl `--config` met de token).

- [ ] **Step 3: codex-review via s4m-queue (GATE)**

```bash
s4m-queue push --to mac:codex --as claude --type review_request --body "Review de Phase 2 mcp-PR (PR_REVIEW kind end-to-end)." --cwd "/Users/janpetervisser/Development" --repo "scrum4me-mcp" --objective "Beoordeel de mcp-diff op de feat/codex-pr-review-phase2 branch tegen de spec." --verification "kind-prompts, fetchPrDiff/postPullRequestReview, post_pr_review-sink, resolvePrLinkedPlan, getFullJobContext PR_REVIEW-tak vóór de MANUAL-branch, CLAIMABLE_STANDALONE. Tests groen." --response-format "GO of NO-GO met genummerde findings P1 P2 P3."
```
Verwerk findings → bij GO: **stop voor user-geautoriseerde merge.** Na merge: door naar Task 8.

---

### Task 8: scrum4me-docker — PR_REVIEW slaat worktree-attach over

**Files:**
- Modify: `scrum4me-docker/bin/run-one-job.ts` (de `attachWorktreeToJob`-call-site)

- [ ] **Step 1: Maak een worktree + lokaliseer de worktree-attach**

```bash
cd /Users/janpetervisser/Development/scrum4me-docker
git fetch origin --quiet
git worktree add /Users/janpetervisser/Development/scrum4me-docker-pr-review -b feat/codex-pr-review-phase2 origin/master
grep -n "attachWorktreeToJob\|ctx.kind\|getKindPromptText" /Users/janpetervisser/Development/scrum4me-docker-pr-review/bin/run-one-job.ts
```

- [ ] **Step 2: Sla worktree-attach over voor PR_REVIEW**

Bij de `attachWorktreeToJob`-call (read-only kinds slaan dit al over voor idea-jobs — volg dat patroon): voeg `PR_REVIEW` toe aan de set kinds die géén worktree krijgen, of guard de call:
```ts
const NO_WORKTREE_KINDS = new Set(['IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'PLAN_CHAT', 'PR_REVIEW'])
// …
if (!NO_WORKTREE_KINDS.has(ctx.kind)) {
  await attachWorktreeToJob(/* … */)
}
```
> NB: pas dit aan op de bestaande structuur — als de runner al per-kind beslist of er een worktree komt, voeg `PR_REVIEW` toe aan die bestaande lijst/conditie i.p.v. een nieuwe set te introduceren (DRY). Verifieer met de grep uit Step 1.

- [ ] **Step 3: Build-config sanity + commit**

```bash
cd /Users/janpetervisser/Development/scrum4me-docker-pr-review
docker compose config >/dev/null && echo "compose OK"   # of, als docker hier niet draait: tsc/lint indien aanwezig
git add bin/run-one-job.ts
git commit -m "feat(docker): PR_REVIEW skips worktree-attach (read-only review)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin feat/codex-pr-review-phase2
```

- [ ] **Step 4: PR + codex-review + GATE-merge**

Open de docker-PR via de Forgejo-API; pin `MCP_GIT_REF` op de mcp-`main` (nu gemerged). codex-review via s4m-queue. **Stop voor user-geautoriseerde merge.**

---

### Task 9: scrum4me-workers — `pr_url`-plumbing + `pr-review`-template + enqueue

**Files:**
- Modify: `scrum4me-workers/lib/manual-job-draft.ts` (`MANUAL_JOB_KINDS`, `ManualJobDraftInput`, `ManualJobLaunchPreview.context`, `buildManualJobLaunchPreview`, zod-parseveld)
- Modify: `scrum4me-workers/lib/manual-jobs/validation.ts` (**eigen** `MANUAL_JOB_KINDS` += PR_REVIEW; `ManualJobValidationInput.prUrl`; PR_REVIEW-veldregels — de echte validator achter het save-draft-pad)
- Modify: `scrum4me-workers/lib/manual-jobs/templates.ts`
- Modify: `scrum4me-workers/components/jobs/manual-job-draft-editor.tsx` (draft-useMemo, ~`:176-188`)
- Modify: `scrum4me-workers/actions/manual-jobs.ts` (enqueue)
- Test: `scrum4me-workers/__tests__/actions/manual-jobs.test.ts`, `__tests__/actions/manual-job-drafts.test.ts` (save-draft persisteert `context.prUrl`), de lib-tests voor `buildManualJobLaunchPreview` en `validateManualJobInput`

**Context (codex plan-review P1 — geverifieerd, round-2 aangescherpt):** de huidige draft-keten persisteert géén `pr_url`. `MANUAL_JOB_KINDS` mist `PR_REVIEW`; `ManualJobDraftInput` kent alleen `taskId`/`ideaId`/`prompt`; `ManualJobLaunchPreview.context` alleen `taskId`/`ideaId`/`instruction`; de editor mapt template-velden alleen naar de prompt; de enqueue leest context via `readTaskIdFromLaunchPreview`/`readIdeaIdFromLaunchPreview`. **Bovendien (round-2):** de échte validator zit in `lib/manual-jobs/validation.ts` — `parseManualJobDraftInput` (manual-job-draft.ts) delegeert naar `validateManualJobInput`, en dát bestand heeft zijn **eigen** `MANUAL_JOB_KINDS` (`:41`) + `ManualJobValidationInput` (`:36-37`, geen `prUrl`) + kind-specifieke veldregels (`:94-98`). Zonder die module te updaten verwerpt `saveManualJobDraftAction` (`actions/manual-job-drafts.ts:32`) elke PR_REVIEW-draft als onbekend jobtype, nog vóór de enqueue. Zonder volledige plumbing queue't een PR_REVIEW-job dus nooit, of met `pr_url = null` waarna de Task 6-tak elke claim terugrolt. **Spiegel daarom het bestaande taskId/ideaId-patroon end-to-end, in béide modules.**

- [ ] **Step 1: Maak een worktree + bump de submodule**

```bash
cd /Users/janpetervisser/Development/scrum4me-workers
git fetch origin --quiet
git worktree add /Users/janpetervisser/Development/scrum4me-workers-pr-review -b feat/codex-pr-review-phase2 origin/main
cd /Users/janpetervisser/Development/scrum4me-workers-pr-review
git submodule update --init vendor/scrum4me-shared
cd vendor/scrum4me-shared && git checkout origin/main && cd ../..
npm install   # postinstall heelt submodule + prisma generate → PR_REVIEW beschikbaar
```

- [ ] **Step 2: Schrijf de falende tests (lib + enqueue)**

**(a) lib-test** — in de test-file waar `buildManualJobLaunchPreview` al getest wordt (zoek met `grep -rln "buildManualJobLaunchPreview" __tests__/`), voeg toe:
```ts
it('buildManualJobLaunchPreview: PR_REVIEW draagt context.prUrl', () => {
  const preview = buildManualJobLaunchPreview({
    title: 'Review PR',
    productId: 'p1',
    kind: 'PR_REVIEW',
    runtime: 'codex',
    adapter: /* zelfde adapter-waarde als de bestaande fixtures in deze file */,
    templateId: 'pr-review',
    templateVersion: 1,
    prUrl: 'https://git.jp-visser.nl/o/r/pulls/5',
    prompt: 'Beoordeel grondig.',
  } as ManualJobDraftInput)
  expect(preview.context?.prUrl).toBe('https://git.jp-visser.nl/o/r/pulls/5')
})
```

**(b) enqueue-tests** — in `__tests__/actions/manual-jobs.test.ts` (mirror de Phase-1 CODEX-test-fixture; de draft-mock krijgt `launch_preview_json` precies zoals `buildManualJobLaunchPreview` het produceert — `context.prUrl`, camelCase):
```ts
it('CODEX PR_REVIEW queue't met pr_url op de job + codex-default snapshot', async () => {
  // arrange: DRAFT-mock met kind PR_REVIEW, runtime CODEX en
  // launch_preview_json: { context: { prUrl: 'https://git.jp-visser.nl/o/r/pulls/5' } }
  // (zelfde fixture-helper als de bestaande CODEX IDEA_REVIEW_PLAN-test)
  await enqueueManualJobAction({ draftId: 'd1', allowQueueWithoutWorker: false })
  const jobArg = vi.mocked(prisma.claudeJob.create).mock.calls.at(-1)?.[0].data
  expect(jobArg.kind).toBe('PR_REVIEW')
  expect(jobArg.pr_url).toBe('https://git.jp-visser.nl/o/r/pulls/5')
  expect(jobArg.requested_model).toBe('codex-default')
})

it('PR_REVIEW zonder prUrl in launch_preview → enqueue weigert', async () => {
  // arrange: zelfde draft-mock maar launch_preview_json: { context: {} }
  const res = await enqueueManualJobAction({ draftId: 'd1', allowQueueWithoutWorker: false })
  expect(res.ok).toBe(false)
  expect(vi.mocked(prisma.claudeJob.create)).not.toHaveBeenCalled()
})
```

**(c) validatie-tests** — in de test-file waar `validateManualJobInput` getest wordt (zoek met `grep -rln "validateManualJobInput" __tests__/`):
```ts
it('PR_REVIEW met geldige prUrl → geen fieldErrors', () => {
  const res = validateManualJobInput({ ...validBase, kind: 'PR_REVIEW', prUrl: 'https://git.jp-visser.nl/o/r/pulls/5' })
  expect(res.fieldErrors?.prUrl ?? res.fieldErrors?.kind).toBeUndefined()
})
it('PR_REVIEW zonder prUrl → fieldError op prUrl', () => {
  const res = validateManualJobInput({ ...validBase, kind: 'PR_REVIEW' })
  expect(res.fieldErrors?.prUrl).toBeTruthy()
})
it('PR_REVIEW met malformed prUrl → fieldError op prUrl', () => {
  const res = validateManualJobInput({ ...validBase, kind: 'PR_REVIEW', prUrl: 'niet-een-url' })
  expect(res.fieldErrors?.prUrl).toBeTruthy()
})
```
> NB: `validBase` = de bestaande geldige-input-fixture in die test-file; mirror de bestaande assert-stijl op het `ManualJobValidationResult`-shape (fieldErrors-naam kan licht afwijken — de bestaande taskId/ideaId-tests tonen het).

**(d) save-draft-test** — in `__tests__/actions/manual-job-drafts.test.ts` (maak aan als die nog niet bestaat; mirror de mock-setup van `manual-jobs.test.ts`):
```ts
it('saveManualJobDraftAction persisteert launch_preview_json.context.prUrl voor PR_REVIEW', async () => {
  // arrange: geldige PR_REVIEW-input (kind, runtime codex, prUrl, prompt, templateId 'pr-review')
  await saveManualJobDraftAction({ /* …mirror de bestaande save-fixture…, kind: 'PR_REVIEW', prUrl: 'https://git.jp-visser.nl/o/r/pulls/5' */ })
  const persisted = vi.mocked(/* de prisma.manualJobDraft create/upsert/update die de action gebruikt */).mock.calls.at(-1)?.[0].data
  expect((persisted.launch_preview_json as any).context.prUrl).toBe('https://git.jp-visser.nl/o/r/pulls/5')
})
```
> NB: dit bewijst het échte save-pad (`saveManualJobDraftAction` → `parseManualJobDraftInput` → `validateManualJobInput` → persist) — zonder de validation.ts-wijziging (Step 5) faalt deze test op "Onbekend handmatig jobtype", precies het round-2-P1-gat. Welke prisma-call de action doet (create/upsert/update) lees je in `actions/manual-job-drafts.ts:32-51`.

- [ ] **Step 3: Run de tests — moeten falen**

Run: `npm test -- __tests__/actions/manual-jobs.test.ts`
Expected: FAIL (PR_REVIEW geen geldig `ManualJobKind`; geen template; `pr_url` niet op de job; geen prUrl-guard).

- [ ] **Step 4: Voeg de `pr-review`-template toe (`lib/manual-jobs/templates.ts`)**

Voeg `'PR_REVIEW'` toe aan het template-kind-union-type, en een template:
```ts
{
  id: 'pr-review',
  version: 1,
  changelog: 'Phase 2: codex PR-code-review',
  label: 'PR-review (codex)',
  description: 'Laat codex een Forgejo PR reviewen en een review-state posten.',
  kind: 'PR_REVIEW',
  defaultRuntime: 'codex',
  allowedRuntimes: ['claude', 'codex'],
  defaultAdapter: /* per bestaand patroon */,
  allowedAdapters: /* per bestaand patroon */,
  defaultCapability: 'review',
  fields: [
    { name: 'product_id', label: 'Product', type: 'product', required: true },
    { name: 'pr_url', label: 'PR URL', type: 'string', required: true, placeholder: 'https://git.jp-visser.nl/owner/repo/pulls/123' },
    { name: 'instructie', label: 'Reviewinstructie', type: 'text', required: false, defaultValue: 'Beoordeel codekwaliteit, architectuur-conformiteit, tests en docs.' },
  ],
  promptSections: [ /* leeg of minimaal; de runner kiest de prompt op kind+runtime */ ],
}
```
> NB: spiegel exact de veld-/type-structuur van de bestaande `idea-review-plan`-template in dit bestand (zelfde `ManualJobTemplate`-type, `defaultAdapter`/`allowedAdapters`).

- [ ] **Step 5: Draft-plumbing in `lib/manual-job-draft.ts`**

Vier wijzigingen, allemaal naar het bestaande taskId/ideaId-patroon:

1. **`MANUAL_JOB_KINDS`** — voeg `'PR_REVIEW'` toe aan de bestaande const-array (achteraan, vóór de `] as const satisfies …`-regel).
2. **`ManualJobDraftInput`** — voeg het veld toe naast `taskId`/`ideaId`:
```ts
export type ManualJobDraftInput = {
  // …bestaande velden ongewijzigd…
  taskId?: string
  ideaId?: string
  prUrl?: string   // PR_REVIEW: de te reviewen Forgejo-PR
  prompt: string
}
```
3. **`ManualJobLaunchPreview.context`** — voeg `prUrl` toe:
```ts
  context?: {
    taskId?: string
    ideaId?: string
    prUrl?: string
    instruction?: string
  }
```
4. **`buildManualJobLaunchPreview`** — neem `prUrl` op in de context-bouw:
```ts
  const context = {
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.ideaId ? { ideaId: input.ideaId } : {}),
    ...(input.kind === 'PR_REVIEW' && input.prUrl ? { prUrl: input.prUrl } : {}),
    ...(isManualIdeaJobKind(input.kind) && input.prompt
      ? { instruction: input.prompt }
      : {}),
  }
```
5. **Zod-parseveld** — voeg `prUrl` toe aan het zod-parse-schema in dit bestand op exact dezelfde manier als `taskId`/`ideaId` (optioneel `trimmedString`-veld), zodat `parseManualJobDraftInput` het veld doorlaat.

Én — **round-2 P1: de echte validator** — in **`lib/manual-jobs/validation.ts`** (NIET alleen manual-job-draft.ts; `validateManualJobDraft` delegeert hierheen):

6. **`ManualJobValidationInput`** (`:36-37`) — voeg `prUrl?: unknown` toe naast `taskId`/`ideaId`.
7. **`MANUAL_JOB_KINDS`** in validation.ts (`:41`) — voeg `'PR_REVIEW'` toe aan déze const-array (anders: "Onbekend handmatig jobtype" bij save).
8. **PR_REVIEW-veldregels** — naast de bestaande taskId/ideaId-regels (`:94-98`):
```ts
  if (input.kind === 'PR_REVIEW') {
    if (isBlank(input.prUrl)) {
      addFieldError(result, 'prUrl', 'PR URL is verplicht voor een PR-review.')
    } else if (
      typeof input.prUrl !== 'string' ||
      !/^https?:\/\/.+\/pulls\/\d+\/?$/.test(input.prUrl.trim())
    ) {
      addFieldError(result, 'prUrl', 'PR URL moet een Forgejo pull-request-URL zijn (…/pulls/<nr>).')
    }
  }
```
> NB: mirror de exacte `addFieldError`/`isBlank`-helpers die de taskId/ideaId-regels in dit bestand al gebruiken. Check ook `isLegacyManualJobKind` (`:145`) — die leest dezelfde array, dus PR_REVIEW telt daarna automatisch mee.

- [ ] **Step 6: Editor-mapping in `components/jobs/manual-job-draft-editor.tsx`**

Het `pr_url`-templateveld rendert al generiek via `template.fields` → `inputValues.pr_url`; alleen de draft-mapping ontbreekt. In de `draft`-useMemo (~`:176-188`), voeg toe naast `taskId`/`ideaId`:
```ts
  const draft = useMemo<ManualJobDraftInput>(() => ({
    // …bestaande velden ongewijzigd…
    taskId: selectedTaskRef,
    ideaId: templateHasIdeaRef ? selectedIdeaId : undefined,
    prUrl: template.kind === 'PR_REVIEW'
      ? (stringFromValue(inputValues.pr_url) || undefined)
      : undefined,
    prompt: renderedPrompt.promptMd,
  }), [/* …bestaande deps…, */ inputValues, template.kind])
```
> NB: verifieer welke builder de gepersisteerde `launch_preview_json` voedt bij save-draft (de editor gebruikt zowel `buildManualJobLaunchPreview(draft)` als `buildManualJobLaunchPreviewBundle({ inputValues, … })`). Zorg dat `prUrl` in het gepersisteerde pad terechtkomt; de enqueue-test (Step 2b) bewijst het end-to-end.

- [ ] **Step 7: Enqueue in `actions/manual-jobs.ts`**

Mirror de bestaande `readTaskIdFromLaunchPreview`/`readIdeaIdFromLaunchPreview`-helpers (zelfde file, zelfde parse-stijl):
```ts
function readPrUrlFromLaunchPreview(json: Prisma.JsonValue | null): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const context = (json as { context?: unknown }).context
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null
  const prUrl = (context as { prUrl?: unknown }).prUrl
  return typeof prUrl === 'string' && prUrl.length > 0 ? prUrl : null
}
```
In de enqueue-transactie (naast de bestaande `taskId`/`ideaId`-reads):
```ts
    const prUrl = draft.kind === 'PR_REVIEW'
      ? readPrUrlFromLaunchPreview(draft.launch_preview_json)
      : null
    if (draft.kind === 'PR_REVIEW' && !prUrl) {
      return { type: 'error', error: 'PR URL is verplicht voor een PR-review.' }
    }
```
En bij de job-create: `pr_url: prUrl` in de `data`. De codex-snapshot-override (`requested_model='codex-default'`) bestaat al (Phase 1). De idea-binding-guard blokkeert niet: `isManualIdeaJobKind` dekt alleen `IDEA_*`-kinds, dus PR_REVIEW valt er vanzelf buiten (de enqueue-test bevestigt dit).

- [ ] **Step 8: Run de tests + verify — moeten slagen**

Run: `npm test -- __tests__/actions/manual-jobs.test.ts && npm run verify`
Expected: PASS + verify groen (lint + typecheck + alle tests).

- [ ] **Step 9: Commit + PR + codex-review + GATE-merge**

```bash
git add lib/manual-job-draft.ts lib/manual-jobs/validation.ts lib/manual-jobs/templates.ts components/jobs/manual-job-draft-editor.tsx actions/manual-jobs.ts __tests__/ vendor/scrum4me-shared
git commit -m "feat(workers): pr_url-plumbing + pr-review template + enqueue" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin feat/codex-pr-review-phase2
```
Open de workers-PR via de Forgejo-API; codex-review via s4m-queue. **Stop voor user-geautoriseerde merge.**

---

### Task 10: Canary — manual-enqueue tegen een wegwerp-PR (GATE)

**Files:** geen; end-to-end-bewijs op host 154.

- [ ] **Step 1: Maak een wegwerp-PR**

Maak op een testrepo onder `git.jp-visser.nl` (binnen `FORGEJO_HOSTS`) een kleine, bewust-verbeterbare PR. Noteer de `pr_url`.

- [ ] **Step 2: Herbouw BEIDE agent-codex-workers naar de nieuwe mcp-main**

Deploy/herbouw `agent-codex` op 154 én max2 met de PR_REVIEW-prompt + `post_pr_review`-sink (via de host-deploy-flow / s4m-queue-task naar `<host>:claude`). **Laat een oude codex-worker eerst uitsterven** vóór de enqueue, anders claimt een pre-Phase-2-worker en faalt op een onbekend kind of een ontbrekende sink.

- [ ] **Step 3: Enqueue een PR_REVIEW-job (MANUAL)**

Via de workers-UI (`/jobs/new` → `pr-review`-template, runtime codex, `pr_url`) of een seed met `source=MANUAL`. Claimer is doorgaans max2 (HIGH_P).

- [ ] **Step 4: Verifieer GO-criteria**

GO ⇔ alle:
- job → `DONE` (bewijst de MANUAL-done-handler `:738`, géén verify-gate-val);
- er staat een Forgejo-review op de PR met de verwachte `event` + samenvattende body;
- bij een gekoppelde PR: de body refereert plan/acceptatie; ongekoppeld: expliciet "geen gekoppeld plan";
- `ClaudeJob.summary` bevat de verdict-trace;
- 0 auth/MCP/Forgejo-fouten; geen hang; de Claude-fleet ongestoord; de codex-worker-rij adverteert `review`.

NO-GO → run-log vastleggen, fix-forward (vrijwel zeker de prompt of het `event`-enum), canary herhalen. Niet door naar Phase 3 tot DONE + review-op-PR bewezen.

- [ ] **Step 5: Afronden**

Werk de auto-memory + de DB-doc `architecture/codex-review-worker` bij naar "Phase 2 DONE". Ruim de worktrees op (`rm -rf <wt> && git worktree prune` voor submodule-repo's).

---

## Self-Review (uitgevoerd)

**Spec-coverage:** §2-scope IN gedekt — enum (T1), prompt+selectie (T2), Forgejo-helpers (T3), sink (T4), plan-koppeling (T5), getFullJobContext-tak + CLAIMABLE (T6), docker skip-worktree (T8), workers pr_url-plumbing+template+enqueue (T9), canary (T10). §5-prompt → T2. §6-sink → T4. §7-koppeling (self-match-excl.) → T5. §9-error-handling → in T4 (fail-on-Forgejo-error), T6 (rollback bij missing/unparseable pr_url), prompt (lege diff). §8-canary → T10 (dual-rebuild). Cross-repo-volgorde §12 → T1→T7→T8→T9→T10.

**Placeholder-scan:** de `> NB:`-noten markeren expliciet waar de implementer een exacte signatuur/veldnaam tegen de bron verifieert (geen verzonnen interface vastgelegd); alle test- en nieuwe-functiecode is volledig. Geen "TODO/later".

**Type-consistentie:** `event`-enum (`APPROVED|REQUEST_CHANGES|COMMENT`) identiek in T3 (helper), T4 (sink-schema), T2 (prompt). `LinkedPlan` (T5) ↔ `linked_plan` payload (T6). `fetchPrDiff`/`postPullRequestReview`-signaturen (T3) ↔ aanroepen in T4/T6. `resolvePrLinkedPlan({ id, pr_url })` (T5) ↔ aanroep in T6.
