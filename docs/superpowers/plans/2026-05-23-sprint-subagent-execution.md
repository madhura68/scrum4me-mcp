# Sprint Sub-Agent Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound a sprint job's context by having the sprint session orchestrate one `Agent` sub-agent per task, and fix token attribution so sub-agent usage is summed into the job total.

**Architecture:** The sprint `claude -p` session becomes a thin orchestrator: per `task_execution` it dispatches an `Agent` sub-agent (isolated context) that implements + commits + logs, then the main session runs the authoritative `verify_sprint_task` gate and the state transitions. The `Agent` tool is added to the SPRINT allow-list only. A spike first determines the on-disk sub-agent transcript layout, then `persist-job-usage.ts` sums those transcripts into the job total. Entirely scrum4me-mcp-side (the runner inherits `job-config.ts`).

**Tech Stack:** TypeScript (ESM), Vitest, Claude Code CLI (`Agent` tool, v2.1.63+).

**Spec:** `docs/superpowers/specs/2026-05-23-sprint-subagent-execution-design.md`

---

## File Structure

**Modify**
- `src/lib/job-config.ts` — add `'Agent'` to the SPRINT allow-list.
- `src/prompts/sprint/implementation.md` — rewrite the per-task workflow to orchestrate sub-agents.
- `scripts/persist-job-usage.ts` — sum sub-agent transcripts into the job total.

**Test / fixtures**
- `__tests__/job-config.test.ts` — SPRINT allows `Agent`; TASK does not.
- `__tests__/kind-prompts.test.ts` — sprint prompt orchestrates via `Agent`, keeps safety + verify.
- `__tests__/fixtures/usage/` — real captured transcripts from the spike (Task 3).
- `__tests__/scripts/persist-job-usage.test.ts` — sub-agent summation (extend existing test file).

Order matters: Task 1 (allow-list) and Task 2 (prompt) enable sub-agents; Task 3 (spike) needs them running to observe transcripts; Task 4 (token sum) consumes the spike's findings.

---

## Task 1: Add the `Agent` tool to the SPRINT allow-list

**Files:**
- Modify: `src/lib/job-config.ts` (SPRINT_IMPLEMENTATION `allowed_tools`)
- Test: `__tests__/job-config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/job-config.test.ts`:

```ts
describe('sub-agent allowlist', () => {
  it('SPRINT_IMPLEMENTATION may dispatch sub-agents (Agent tool)', () => {
    expect(getKindDefault('SPRINT_IMPLEMENTATION').allowed_tools).toContain('Agent')
  })

  it('TASK_IMPLEMENTATION may NOT dispatch sub-agents', () => {
    expect(getKindDefault('TASK_IMPLEMENTATION').allowed_tools).not.toContain('Agent')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/job-config.test.ts`
Expected: FAIL — SPRINT list has no `'Agent'`.

- [ ] **Step 3: Implement**

In `src/lib/job-config.ts`, the `SPRINT_IMPLEMENTATION.allowed_tools` array currently is `[...TASK_TOOLS, 'mcp__scrum4me__update_task_execution', 'mcp__scrum4me__verify_sprint_task']`. Add `'Agent'` immediately after the spread:

```ts
    allowed_tools: [
      ...TASK_TOOLS,
      'Agent',
      'mcp__scrum4me__update_task_execution',
      'mcp__scrum4me__verify_sprint_task',
    ],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/job-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/job-config.ts __tests__/job-config.test.ts
git commit -m "feat(sprint): allow the Agent sub-agent tool in the sprint allowlist"
```

---

## Task 2: Rewrite the sprint prompt to orchestrate sub-agents

**Files:**
- Modify: `src/prompts/sprint/implementation.md`
- Test: `__tests__/kind-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/kind-prompts.test.ts`:

```ts
describe('sprint prompt orchestrates sub-agents', () => {
  it('SPRINT instructs Agent sub-agent dispatch and keeps the verify-gate in the main session', () => {
    const s = getKindPromptText('SPRINT_IMPLEMENTATION')
    expect(s).toContain('Agent')
    expect(s).toContain('sub-agent')
    expect(s).toContain('verify_sprint_task')
    // safety + guide pointer still present
    expect(s).toMatch(/GEEN.*job_heartbeat/)
    expect(s).toContain('worktree')
    expect(s).toContain('get_agent_guide')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/kind-prompts.test.ts`
Expected: FAIL — the current prompt doesn't mention `Agent`/`sub-agent`.

- [ ] **Step 3: Rewrite the workflow section**

Read `src/prompts/sprint/implementation.md`. Replace the entire `## Workflow per task_execution` section (its intro line + numbered steps 1–6) with:

```markdown
## Workflow per task_execution

Voor elke entry in `task_executions[]` (in order-volgorde) ben jij de **orchestrator** —
delegeer de zware uitvoering aan een sub-agent zodat je eigen context slank blijft:

1. **Start**: `update_task_execution({ execution_id, status: 'RUNNING' })` en
   `update_task_status({ task_id, status: 'in_progress', sprint_run_id })`.
2. **Delegeer naar een sub-agent** (de `Agent`-tool). Geef een zelfstandige opdracht met
   het `plan_snapshot` van deze execution, de relevante `task`/`story`/`pbi`-context uit
   de payload en het `worktree_path`. Instrueer de sub-agent om: uitsluitend in
   `worktree_path` te werken, per logische laag te committen (`git add -A && git commit`,
   **geen** `git push`), te loggen via `log_implementation` / `log_commit` /
   `log_test_result`, en een **beknopte samenvatting** terug te geven (wat gewijzigd,
   commit-hashes, testuitslagen). Lees zelf geen code-bestanden in — houd dat in de
   sub-agent-context.
3. **Verify-gate** (als `verify_required === true`):
   `mcp__scrum4me__verify_sprint_task({ execution_id })`. Dit draait in jóúw sessie en is
   **bepalend** — niet de zelf-inschatting van de sub-agent. Bij DIVERGENT: stop de sprint
   en `update_job_status('failed')`.
4. **Afronden taak**:
   - Bij ALIGNED/PARTIAL: `update_task_status({ task_id, status: 'done', sprint_run_id })`
     en `update_task_execution({ execution_id, status: 'DONE' })`.
   - Bij EMPTY (no-op): `update_task_execution({ execution_id, status: 'SKIPPED' })`
     en `update_task_status({ task_id, status: 'done', sprint_run_id })`.
```

Leave the `## Hard regels`, `## Sprint afronden`, and `## Vragen aan de gebruiker` sections unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/kind-prompts.test.ts`
Expected: PASS (all, including the new + the existing invariant guards).

- [ ] **Step 5: Commit**

```bash
git add src/prompts/sprint/implementation.md __tests__/kind-prompts.test.ts
git commit -m "feat(sprint): orchestrate per-task sub-agents in the sprint prompt"
```

---

## Task 3: Spike — determine the sub-agent transcript layout

**Goal:** an empirical, documented answer to *where* sub-agent transcripts live, *how* they associate to a session, and *which* assistant `usage` lines they carry — plus committed fixtures for Task 4. No `src/` changes.

- [ ] **Step 1: Produce a real sub-agent transcript**

With Tasks 1–2 in place, run a minimal real invocation that dispatches a sub-agent. Easiest repro (no DB needed):

```bash
cd /tmp && rm -rf sa-spike && mkdir sa-spike && cd sa-spike && git init -q
claude -p "Use the Agent tool to dispatch one sub-agent that runs 'echo hello > note.txt' and reports back. Then stop." --allowedTools "Agent,Bash,Read,Write" --output-format text
```

- [ ] **Step 2: Locate and document the transcripts**

```bash
ls -R ~/.claude/projects/ | grep -i "sa-spike" -A3
# find the project dir, then inspect:
find ~/.claude/projects/*sa-spike* -name '*.jsonl' -newermt '-10 minutes'
```

Document in the plan (edit this Task's notes below) and confirm:
- The exact path/dir of the **main** transcript vs the **sub-agent** transcript(s) (is there a `subagents/` subdir? a flat sibling file?).
- The field that ties a sub-agent transcript to the parent session (`session_id`? `parent_tool_use_id`? filename pattern?). This is what scopes summation to ONE job.
- That sub-agent assistant lines carry a `message.usage` block with the same shape as the main transcript.

- [ ] **Step 3: Capture fixtures**

Copy a trimmed main transcript and one sub-agent transcript into the repo as fixtures (strip any sensitive content; keep a few assistant `usage` lines each):

```bash
mkdir -p __tests__/fixtures/usage
# cp <main.jsonl>      __tests__/fixtures/usage/main.jsonl
# cp <subagent.jsonl>  __tests__/fixtures/usage/subagent.jsonl
```

- [ ] **Step 4: Write the findings into Task 4**

Before coding Task 4, fill its `DISCOVERY` note (below) with the confirmed dir/glob and the session-scoping field. Then commit the fixtures + findings:

```bash
git add __tests__/fixtures/usage docs/superpowers/plans/2026-05-23-sprint-subagent-execution.md
git commit -m "chore(usage): capture sub-agent transcript fixtures + layout findings (spike)"
```

---

## Task 4: Sum sub-agent transcripts into the job total

**Depends on Task 3.** `DISCOVERY` (fill from the spike): sub-agent transcripts live at `____`; scoped to a session by `____`.

**Files:**
- Modify: `scripts/persist-job-usage.ts`
- Test: `__tests__/scripts/persist-job-usage.test.ts`

- [ ] **Step 1: Write the failing test (using the captured fixtures)**

Add to `__tests__/scripts/persist-job-usage.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTranscript, computeUsageFromTranscript, sumSubagentUsage } from '../../scripts/persist-job-usage.js'

it('adds sub-agent transcript usage to the main-session total', async () => {
  const dir = join(__dirname, '..', 'fixtures', 'usage')
  const mainPath = join(dir, 'main.jsonl')
  const main = computeUsageFromTranscript(parseTranscript(readFileSync(mainPath, 'utf8')))
  const sub = await sumSubagentUsage(mainPath)
  // The sub-agent fixture carries real usage, so it contributes a positive total.
  expect(sub.input + sub.output).toBeGreaterThan(0)
  // Combined total is main + sub-agent, never less than main alone (no double-count).
  expect(main.input_tokens + sub.input).toBeGreaterThanOrEqual(main.input_tokens)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/scripts/persist-job-usage.test.ts`
Expected: FAIL — `sumSubagentUsage` is not exported yet.

- [ ] **Step 3: Implement `sumSubagentUsage` and wire it in**

In `scripts/persist-job-usage.ts`: change the existing `import { readFile } from 'node:fs/promises'` to `import { readFile, readdir } from 'node:fs/promises'`, add `import { dirname, join } from 'node:path'`, then add this exported function:

```ts
export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number }

// Sum assistant-message usage across this session's sub-agent transcripts.
// They are SEPARATE files (their lines never appear in the main transcript, where
// isSidechain lines are already skipped), so this adds no double-count.
// DISCOVERY (Task 3): subagent dir + session-scoping confirmed by the spike.
export async function sumSubagentUsage(mainTranscriptPath: string): Promise<UsageTotals> {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const subDir = join(dirname(mainTranscriptPath), 'subagents') // CONFIRM/adjust per Task 3
  let files: string[]
  try {
    files = (await readdir(subDir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return totals // no sub-agents for this session
  }
  for (const f of files) {
    let raw: string
    try {
      raw = await readFile(join(subDir, f), 'utf8')
    } catch {
      continue
    }
    for (const line of parseTranscript(raw)) {
      if (line.type !== 'assistant') continue
      const u = line.message?.usage
      if (!u) continue
      totals.input += u.input_tokens ?? 0
      totals.output += u.output_tokens ?? 0
      totals.cacheRead += u.cache_read_input_tokens ?? 0
      totals.cacheWrite += u.cache_creation_input_tokens ?? 0
    }
  }
  return totals
}
```

In `persistJobUsage`, after `const usage = computeUsageFromTranscript(lines)`, add the sub-agent totals before the prisma write:

```ts
  const sub = await sumSubagentUsage(transcriptPath)
  usage.input_tokens += sub.input
  usage.output_tokens += sub.output
  usage.cache_read_tokens += sub.cacheRead
  usage.cache_write_tokens += sub.cacheWrite
```

(If the spike showed sub-agent files are NOT in a per-session location, scope the `files` list to this session using the field from Task 3's `DISCOVERY` note before summing.)

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run __tests__/scripts/persist-job-usage.test.ts && npm run typecheck`
Expected: test PASS; typecheck only the known `@types/express` errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/persist-job-usage.ts __tests__/scripts/persist-job-usage.test.ts
git commit -m "feat(usage): sum sub-agent transcript tokens into the job total"
```

---

## Final verification

- [ ] **Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; typecheck only the pre-existing `@types/express` errors in `src/http.ts`.

- [ ] **Real sprint smoke (needs DB + worker image)**

Run a multi-task `SPRINT_IMPLEMENTATION` job. Confirm: each task ran in a sub-agent (the main run-log stays small), `verify_sprint_task` gated each task, the job finished, and the persisted `claude_jobs` row's token total reflects main + sub-agent usage. If you can't run a live sprint, say so explicitly rather than claiming success.

---

## Spec coverage check

| Spec item | Task |
|---|---|
| `Agent` added to SPRINT allow-list (TASK excluded) | Task 1 |
| Sprint prompt orchestrates per-task sub-agents; verify-gate authoritative in main | Task 2 |
| Token-attribution spike (layout + fixtures) | Task 3 |
| Sum sub-agent transcripts into job total, no double-count | Task 4 |
| scrum4me-docker untouched (allow-list propagates via job-config) | (no task — by omission) |
| Splitting / task-job sub-agents / custom agent defs | out of scope |
```
