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

## Report infra problems
- When you hit a problem on a host that does not belong to one task — a service that falls
  over, a claim that disappears, a timer that stops running — register it with create_issue
  on that host's product (max2 or scrum4me-server). Without this step nothing is ever
  recorded and the next agent rediscovers it from scratch.
- Always pass a fingerprint shaped as host:component:core, for example
  max2:mcp:claim-lost or scrum4me-server:caddy:cert-renewal-failed. The same fingerprint on
  a recurrence counts up on the existing issue instead of making a copy, and reopens it
  automatically if it had been closed as resolved. Without a fingerprint you get a new
  issue every single time.
- Set reported_by to your own queue address: the host plus your model name, shaped as
  host:model.
- Write findings and the fix with update_issue (append_research / append_resolution, with
  authored_by set to your own address). Those fields append, so you do not wipe a
  predecessor's work. Closing is only possible together with a resolution.
- No secrets in issues. The content is mirrored to Forgejo and is readable there by anyone
  with repository access.

## When to ask
- If a blocking decision genuinely needs the user, ask with ask_user_question and wait for
  the answer. Don't guess on ambiguous requirements — but don't ask for anything you can
  derive from the plan or the docs.
`
