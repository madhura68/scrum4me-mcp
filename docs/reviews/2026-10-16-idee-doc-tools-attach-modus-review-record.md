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
