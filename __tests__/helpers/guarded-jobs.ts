// Test helper: de job-rijen waarvoor isHarnessJobRow/isHarnessJob (src/git/local-llm.ts, spec §5.6) waar is, en de
// gewone job ertegenover. Elke git-bescherming wordt voor beide soorten getest (it.each): de HARNESS-tak (runtime) is
// nieuw, de local_llm-tak (required_capability) blijft permanent.

export type JobRow = { runtime: string; required_capability: string | null }

export const GUARDED_JOBS: ReadonlyArray<{ label: string; job: JobRow }> = [
  { label: 'local_llm-job', job: { runtime: 'CLAUDE', required_capability: 'local_llm' } },
  { label: 'HARNESS-job', job: { runtime: 'HARNESS', required_capability: null } },
]

export const ORDINARY_JOB: JobRow = { runtime: 'CLAUDE', required_capability: null }
