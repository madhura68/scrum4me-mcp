// Multi-worker instance ID resolution (PBI-multi-worker, Phase 2 Task 4).
//
// Reads SCRUM4ME_INSTANCE_ID from the environment. The Docker runner
// (scrum4me-docker/bin/entrypoint.sh) exports this from
// WORKER_INSTANCE_ID or $(hostname); container-internal MCP calls then
// see the container hostname and write that to claude_workers/claude_jobs.
//
// For host-side stdio MCP processes (one per Claude Code session) the env
// is not set, so we derive a stable per-process identity from hostname+pid
// instead of colliding everyone on the literal 'legacy'. This lets the
// nazorg step `ALTER COLUMN instance_id DROP DEFAULT` eventually run.
import os from 'node:os'

export function getInstanceId(): string {
  const fromEnv = process.env.SCRUM4ME_INSTANCE_ID?.trim()
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return `mcp-${os.hostname()}-${process.pid}`
}
