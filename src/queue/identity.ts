import {
  QUEUE_JOB_SERVER,
  QUEUE_MODELS,
  QUEUE_SERVERS,
  parseQueueAddress,
  type QueueAddress as QueueDestination,
  type QueueModel,
  type QueueServer,
} from '@shared/queue-identity.js'
import type { QueueAddress } from './types.js'

/**
 * Queue identity (spec §3): address = (S4M_SERVER, model). S4M_SERVER comes
 * from the host env (already present per host); S4M_MODEL is set in the
 * mcpServers config block (claude config: 'claude', codex config: 'codex').
 * The optional per-call `as` parameter overrides the model only.
 * Missing/invalid identity → QUEUE_IDENTITY_REQUIRED (spec §7).
 */
export function resolveQueueIdentity(asOverride?: string): QueueAddress {
  const server = process.env.S4M_SERVER?.trim()
  if (!server || !(QUEUE_SERVERS as readonly string[]).includes(server)) {
    throw new Error(
      `QUEUE_IDENTITY_REQUIRED: S4M_SERVER must be one of [${QUEUE_SERVERS.join(', ')}] (was: ${server || 'empty'})`,
    )
  }
  const model = (asOverride ?? process.env.S4M_MODEL)?.trim()
  if (!model || !(QUEUE_MODELS as readonly string[]).includes(model)) {
    throw new Error(
      `QUEUE_IDENTITY_REQUIRED: S4M_MODEL (or the 'as' parameter) must be one of [${QUEUE_MODELS.join(', ')}] (was: ${model || 'empty'})`,
    )
  }
  return { server: server as QueueServer, model: model as QueueModel }
}

/**
 * Parses '<server>:<model>' or 'scrum4us-job:<jobid>' destinations — the
 * discriminated parse from the shared module (M30 §5), same vocabulary as the
 * CLI's parseTarget. Identity (the sender) stays closed; only destinations
 * admit the job namespace.
 */
export function parseQueueTarget(s: string): QueueDestination {
  try {
    return parseQueueAddress(s)
  } catch {
    throw new Error(
      `VALIDATION_ERROR: invalid target '${s}', expected <server>:<model> with server in ` +
        `[${QUEUE_SERVERS.join(', ')}], model in [${QUEUE_MODELS.join(', ')}], ` +
        `or ${QUEUE_JOB_SERVER}:<jobid>`,
    )
  }
}
