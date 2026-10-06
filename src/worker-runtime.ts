import { normalizeAgentRuntime, type AgentRuntime } from '@shared/agent-runtime.js'

// De runtime van een worker is de gedeelde AgentRuntime (CLAUDE | CODEX | HARNESS): één bron,
// geen eigen lijst die naast de Prisma-enum kan wegdrijven.
export type WorkerRuntime = AgentRuntime

/**
 * Leest een runtime-aanduiding (bv. uit SCRUM4ME_WORKER_RUNTIME): hoofdletterongevoelig, spaties
 * eromheen genegeerd. Leeg of ontbrekend is de gedocumenteerde standaard CLAUDE. Elke andere
 * waarde die geen runtime is gooit UNKNOWN_AGENT_RUNTIME; een typfout in de configuratie van een
 * worker mag nooit stil een Claude-worker worden. De waarde zelf staat bewust niet in de melding.
 */
export function parseWorkerRuntime(value: string | null | undefined): WorkerRuntime {
  return normalizeAgentRuntime(value?.trim().toUpperCase())
}

export function getWorkerRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerRuntime {
  return parseWorkerRuntime(env.SCRUM4ME_WORKER_RUNTIME)
}
