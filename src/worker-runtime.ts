export type WorkerRuntime = 'CLAUDE' | 'CODEX'

export function parseWorkerRuntime(value: string | null | undefined): WorkerRuntime {
  const normalized = value?.trim().toUpperCase()
  return normalized === 'CODEX' ? 'CODEX' : 'CLAUDE'
}

export function getWorkerRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerRuntime {
  return parseWorkerRuntime(env.SCRUM4ME_WORKER_RUNTIME)
}
