// Global default "build & document" guide. Embedded as a TS string (not a
// runtime .md read): tsc does not copy .md into dist, and the MCP server may
// run from dist/ — a TS module compiles normally and works from src/ and dist/.
// Keep model-agnostic: reference MCP tools and the git/PR flow, not any vendor.
export const AGENT_GUIDE_DEFAULT = `# Build & document guide

This guide is binding. Follow it together with the task's own implementation plan.

## Building
- Work only in the assigned worktree path from the job payload; never edit other directories.
- Make small, logical commits: read -> change -> test -> commit per layer.
- Prefer reusing existing utilities and patterns over adding new ones (DRY, YAGNI).
- Run the test suite and the type checker before marking work done.

## Documenting
- Log each implementation step with log_implementation (what changed and why).
- Log every commit with log_commit (commit hash + message).
- Log test runs with log_test_result (PASSED/FAILED + a short explanation).
- When you introduce architecture, patterns, or decisions worth keeping, capture them
  with create_product_doc in the appropriate folder.

## Verifying
- Run the verify gate before done (verify_task_against_plan or verify_sprint_task).
- Open a PR through the configured automation; do not push to the main branch directly.
`
