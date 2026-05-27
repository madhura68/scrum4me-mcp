// Multi-worker instance ID resolution (PBI-multi-worker, Phase 2 Task 4).
//
// Reads SCRUM4ME_INSTANCE_ID from the environment. The Docker runner
// (scrum4me-docker/bin/run-one-job.ts, Phase 3 Task 3.3) is responsible
// for setting this; for non-containerised single-worker deployments and
// older runners that have not yet been upgraded, the default 'legacy'
// matches the DB column default so existing rows keep their identity.

export function getInstanceId(): string {
  const fromEnv = process.env.SCRUM4ME_INSTANCE_ID?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'legacy'
}
