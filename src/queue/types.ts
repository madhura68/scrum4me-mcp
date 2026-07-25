// mcp-eigen aanvullingen op het gedeelde queue-vocabulaire. Het vocabulaire
// zelf (servers, modellen, types, statussen, sources, reply-mapping en de
// guards) komt uit scrum4me-shared/lib/queue-identity.ts en wordt hier
// bewust NIET opnieuw ge-exporteerd: elke plek importeert het rechtstreeks,
// zodat de herkomst per bestand leesbaar blijft.

import type { QueueModel, QueueRequestType, QueueServer } from '@shared/queue-identity.js'

export interface QueueAddress {
  server: QueueServer
  model: QueueModel
}

export function requiresTaskMeta(t: QueueRequestType): boolean {
  return t === 'task' || t === 'review_request'
}

export interface QueueTaskMeta {
  cwd: string
  repo: string
  objective: string
  verification: string
  response_format: string
  branch?: string
  worktree?: string
  expected_result?: string
  allowed_actions?: string[]
}

const REQUIRED_TASK_META: readonly (keyof QueueTaskMeta)[] = [
  'cwd', 'repo', 'objective', 'verification', 'response_format',
]

/** Throws when the required meta.task contract is missing or incomplete. */
export function validateTaskMeta(task: unknown): QueueTaskMeta {
  if (!task || typeof task !== 'object') {
    throw new Error('VALIDATION_ERROR: meta.task is missing (required for task/review_request)')
  }
  const t = task as Record<string, unknown>
  for (const k of REQUIRED_TASK_META) {
    if (typeof t[k] !== 'string' || (t[k] as string).trim() === '') {
      throw new Error(`VALIDATION_ERROR: meta.task.${k} is missing or empty (required)`)
    }
  }
  const validated: QueueTaskMeta = {
    cwd: t.cwd as string,
    repo: t.repo as string,
    objective: t.objective as string,
    verification: t.verification as string,
    response_format: t.response_format as string,
  }
  if (typeof t.branch === 'string') validated.branch = t.branch
  if (typeof t.worktree === 'string') validated.worktree = t.worktree
  if (typeof t.expected_result === 'string') validated.expected_result = t.expected_result
  if (Array.isArray(t.allowed_actions) && t.allowed_actions.every((a) => typeof a === 'string')) {
    validated.allowed_actions = t.allowed_actions as string[]
  }
  return validated
}
