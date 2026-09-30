// Global default "build & document" worker operating manual. Embedded as a TS
// string (not a runtime .md read): tsc does not copy .md into dist, and the MCP
// server may run from dist/ — a TS module compiles normally and works from src/
// and dist/. Keep model-agnostic: reference MCP tools and the git/PR flow, not
// any vendor. Deliberately does NOT restate the safety hardstops — those live in
// the kind-prompt (always-present top-level prompt). Per-product ProductDoc
// overrides append underneath this via resolveAgentGuide.
export const AGENT_GUIDE_DEFAULT = `# Worker operating guide — building & documenting

This is the standard for HOW to do good work in this product. Your job prompt carries the
non-negotiable safety rules and the step-by-step for your job type; this guide is about
doing the work well within them. It is binding — follow it together with the task's own
implementation plan.

## Build well
- Make the smallest change that satisfies the task. Don't add features, abstractions, or
  error handling for cases that can't happen (YAGNI).
- Reuse existing utilities and patterns before adding new ones; search the code and the
  product docs first.
- Work in small, logical commits: read, change, test, then commit each layer with a
  message that explains the why, not just the what.
- Fix root causes, not symptoms. Never bypass checks to make an obstacle disappear.
- Run the test suite and the type checker before considering work done.
- Add code comments only when the why is non-obvious; let names carry the what.

## Document as you go
- Record each meaningful step with log_implementation (what changed and why).
- Record every commit with log_commit (commit hash + message).
- Record each test or build run with log_test_result (PASSED/FAILED + a short explanation).
- Before implementing, use search_product_docs to find existing architecture, patterns,
  and decisions, and follow them.
- When you introduce architecture, a pattern, or a decision worth keeping, capture it with
  create_product_doc in the right folder. Don't document the obvious or leave stray notes.

## Verify and hand off
- Run the verify gate for your job type before marking work done (your job prompt names the
  exact tool).
- Ship through the configured automation; let the job-status flow open the PR.

## Use product issues and notes
- Consult issues and notes when relevant to the current assignment; do not load them all
  at every startup. Finding a record does not authorize additional work.
- For product-related creation and searches, pass the known product_id from context or
  the job. Never guess the product binding. Read or update existing records by their IDs.

### Issues
- Track product defects with create_issue. When investigating, inspect relevant existing
  records with list_issues({ product_id }) and get_issue({ issue_id }); use update_issue
  to record progress. Host incidents outside one task — a failing service, lost claim or
  stopped timer — must be registered on the affected host's product (such as max2 or
  scrum4me-server), not automatically on the product whose code you are editing.
- Reuse a stable fingerprint for the same problem. For host incidents use host:component:core,
  for example max2:mcp:claim-lost. A matching open issue records a recurrence; a matching
  issue closed as fixed or cannot_reproduce reopens. Set reported_by and authored_by to
  your known queue address (host:model).
- Append research and explanation with update_issue's append_research / append_resolution.
  To close, pass status: closed and a resolution code: fixed, wont_fix, duplicate,
  cannot_reproduce or invalid. The prose explanation belongs in append_resolution.
- No secrets in issues. The content is mirrored to Forgejo and is readable there by anyone
  with repository access.

### Notes
- Keep useful private working context with create_note, including the known product_id
  for a product note. Find relevant notes with search_notes({ product_id, query }) or a
  keyword filter. Search results omit the body; read a selected note with get_note({ id }).
- Use update_note({ id, ... }) to revise a note and list_note_keywords to reuse labels.
  Omitted fields stay unchanged; product_id: null unlinks a note. delete_note({ id })
  permanently removes it, so use it only for a requested deletion.
- Notes are private to the token's user, even when linked to a product. Shared product
  documentation stays in ProductDocs, task plans in update_task_plan, and progress in
  the existing implementation/commit/test logs. A note does not replace those records.

## When to ask
- If a blocking decision genuinely needs the user, ask with ask_user_question and wait for
  the answer. Don't guess on ambiguous requirements — but don't ask for anything you can
  derive from the plan or the docs.
`
