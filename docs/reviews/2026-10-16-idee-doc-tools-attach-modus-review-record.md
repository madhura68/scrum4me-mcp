# Review record: idee-doc-tools in attach-modus (plan, increment 1)

- **Document:** `docs/superpowers/plans/2026-10-16-idee-doc-tools-attach-modus.md`
- **Branch:** `claude/idee-attach-modus`
- **Phase:** plan. Maximum 10 rounds.
- **Reviewers:** dispatch jobs, codex (`runtime: CODEX`) and claude (`runtime: CLAUDE`).
- **Idea link:** none (JP-besluit 2, 2026-10-16: no registration).
- **Assignment from JP (2026-10-16):** "Doe eerst een review-loop (codex + claude) over het plan; daarna ceremonie op mijn akkoord." Decisions: 1 = (a), 2 = no, 3 = yes.

## Rounds

### Round 1 — rev 1 @ `ed6ecf7170c56dc6962b6199375f040e68c8f621`

- **Pin:** `doc` = plan, sha256 `4452f57c…ec2e`. No idea_link.
- **CODEX:** request `1d215d79-bd2b-476a-bade-dad1972413e9`, root `b60d3812-6e7e-4b82-ae5e-6f70f381498e`, key `69ed9e6a-…178d`. **NO-GO**: 0B/1M/1m.
- **CLAUDE:** request `013892da-a0c3-4d98-a4db-1ed2de04f4be`, root `0daa75ca-6aaf-4cf2-833e-34659726b23d`, key `2ecdcb4d-…29b1`. **GO**: 0B/0M/4m.

Triage:

| # | Reviewer | Finding | Verified | Remedy |
|---|---|---|---|---|
| C-M1 | codex MAJOR | The close checks (status, jobs) run before the write transaction, so a concurrent dispatch can be overwritten by PLANNED. | Yes. `dispatchIdeaJob` writes GRILLING in its own transaction without a prior lock (`idea-jobs.ts:118-133`); `update_idea` updates on id only. | **Accepted.** The status path runs `lockIdeaRow` and then re-reads status and jobs in the same transaction, using the existing helper (`idea-plan-loop.ts:82`). Order test plus a re-read test. Residual window (dispatch read before the lock, writes GRILLING after the commit) accepted as consistent. **Rejected:** a deterministic interleaving integration test. The mock tests cannot prove concurrency (CLAUDE.md), and the existing `lockIdeaRow` users in the spec/plan loop have none either. Carried to round 2 for adjudication. |
| C-m1 | codex MINOR | External inputs (IDEA-263 docs, rules, memories) are not pinned. | Yes | **Accepted.** Tasks 4 and 5 read the current revision first and record doc id, revision and sha256. |
| C-scope | codex | The yaml summary in the plan description can be deferred. | Yes (also claude) | **SCHRAP** to "Niet in increment 1". |
| L-m1 | claude MINOR | A standalone SPEC_REVIEW has no `idea_id` and does not touch the status, so Review Focus 1 named the wrong cause. | Yes (`review-jobs.ts:140-151`, `submit-review.ts:575`) | **Accepted.** Review Focus 1 rewritten; the test is now named after the pipeline SPEC_REVIEW. |
| L-m2 | claude MINOR | The mock and transaction shape are underspecified, `IdeaLog.content` has no value. | Yes (`update-idea.test.ts` mock) | **Accepted.** Only the status path goes through `$transaction`; mock extension named; content `Status <from> → PLANNED (update_idea)`. |
| L-m3 | claude MINOR | `in: ACTIVE_JOB_STATUSES` does not typecheck against a readonly tuple. | Yes (spread pattern `idea-jobs.ts:91`) | **Accepted.** `[...]` for both constants. |
| L-m4 | claude MINOR | Closing is not idempotent, SPEC_FAILED is not closable, `chat.md` step 5 conflicts. | Yes | **Accepted** in part. A second close is a no-op with a test. SPEC_FAILED stays refused and is documented (Review Focus 7). `chat.md` stays unchanged (JP decision 3), with an explanation in Review Focus 6. |

**Scope delta:** removed the yaml summary; added the lock and re-read in the close path (no new component, an existing helper) and the idempotent no-op. First usable result unchanged.

### Round 2 — rev 2 @ `3c4ab58d4ab8d26da0fd38b21e2f8bd457439678`

- **Pin:** `doc` = plan, sha256 `d6fa5bc5…bb73`. No idea_link.
- **CODEX:** request `801733dd-b623-423e-810a-e57a679c4bdd`, root `811d625b-e6ab-4022-8380-b8a3cea69512`, key `347b29ec-…6d6`. **GO**: 0B/0M/2m.
- **CLAUDE:** request `4c8951d1-4ffe-49e7-8e5f-ffce5e68c65f`, root `4c5f41e4-f458-4112-86b1-0984dafa537e`, key `b97e4e03-…a50`. **GO**: 0B/0M/4m.
- **Round-1 fixes:** codex held 1, 2, 4, 5 and 7, held 6 and 8 partly (see C2-m1), and held 3 partly (see C2-m2). Claude held all eight.
- **Adjudication of the rejected interleaving test:** both reviewers upheld the rejection for this scope. Claude adds that `claudeJob.create` with `idea_id` waits on the `FOR UPDATE` lock through the FK, and that the `tx.$queryRaw` assertion catches the only failure mode a mock can see (the lock taken outside `tx`). Codex notes that the cited CLAUDE.md quotation is about driver error shapes, not concurrency. The rejection holds anyway, because no failure path is left that needs a real-DB test.
- **Scope:** neither reviewer found a removal candidate; `review_dispatched` on the spec tool is needed for acceptance (b). Codex considers the plan counterpart optional but proportionate, so it stays.

Triage:

| # | Reviewer | Finding | Verified | Remedy |
|---|---|---|---|---|
| C2-m1 | codex MINOR | The no-op close returns `code`, but the ownership query only selects `id, status`. | Yes (`update-idea.ts:43-45`, pin in `update-idea.test.ts:168-171`) | **Accepted.** The ownership select gains `code`, the pinned select test is updated (named as an exception in Global Constraints), and the no-op test asserts all three fields. |
| C2-m2 | codex MINOR | External inputs (IDEA-263 docs, rules, memories) are not in the review bundle. | Yes | **No change.** Tasks 4/5 already read and record revision and sha256 before writing. These are execution prerequisites, not review evidence. |
| L2-m1 | claude MINOR | The residual-window justification only covers IDEA_GRILL. | Yes (`idea-jobs.ts:20-39`: MAKE_SPEC from GRILLED/SPEC_FAILED, MAKE_PLAN from GRILLED/PLAN_FAILED/PLAN_READY) | **Accepted.** Reworded: the job is real and sets its own next status; PLANNED is an allowed source only for IDEA_GRILL. |
| L2-m2 | claude MINOR | A stuck IDEA_CHAT job blocks the close and no remedy is named. | Yes. The MCP has no job-cancel tool (`update_job_status` enum without cancelled). The web app has `cancelClaudeJobAction` (any active job by id), while `cancelIdeaJobAction` refuses IDEA_CHAT. | **Accepted.** The remedy is in the Task 3 interfaces, and the message now ends with `— wacht tot die klaar is of annuleer hem`. |
| L2-m3 | claude MINOR | A `null` from the re-read in the transaction is not specified. | Yes | **Accepted.** `null` → `Idea not found`, with a test. |
| L2-m4 | claude MINOR | Review Focus 2 recovery path needs a worker. | Yes (`idea-jobs.ts:69-115`) | **Accepted.** Focus 2 names the plan-write path (no worker) first; IDEA_GRILL needs a worker and a `repo_url`. |

**Verdict:** GO/GO on `3c4ab58`. The plan phase is done.

**Post-GO edits:** only the five accepted MINORs above. They are text and test specification, with no design change and no new component, and they were not reviewed again. A delta round (single reviewer, CODEX) is possible on JP's request.

**Scope delta:** no work removed. Added: one select field, one test assertion and one test for the `null` case, plus wording. First usable result and practical proof unchanged.
