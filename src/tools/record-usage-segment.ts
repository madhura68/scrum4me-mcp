// IDEA-235 (spec §4.5, plan Taak 8): the usage-ledger mod stores one stretch of interactive
// session time per task or sprint overhead. Only tokens are stored; USD is computed at read time.
//
// Order per message: (1) ownership and access, (2) the lifecycle, which is monotonic per id:
//   - new segment (header or full message): needs an anchor task with a sprint; fixes the owner,
//     product and sprint as the anchor is now;
//   - header on an existing segment: no effect;
//   - closing message on an open segment: end, times, cost and lines in one transaction;
//   - any message on a closed segment: succeeds without effect (the first closing wins).
// Owner, product, sprint, task and anchor are never overwritten.
//
// Rejections the mod must not retry start with REJECTED; any other error is transient.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Prisma, UsageEndedReason } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { resolveProductRef } from '../lib/resolve-entity.js'
import { formatZodError, toolError, toolJson, withToolErrors } from '../errors.js'
import { UNIQUE_VIOLATION, driverAdapterCause } from '../lib/prisma-driver-error.js'
import { taskStatusFromApi } from '../status.js'

export const REJECTED = 'USAGE_SEGMENT_REJECTED'

const ENDED_REASONS = ['todo', 'review', 'done', 'failed', 'excluded', 'switched', 'session_end', 'untracked'] as const
const OWN_REASONS: Record<string, UsageEndedReason> = { switched: 'SWITCHED', session_end: 'SESSION_END', untracked: 'UNTRACKED' }

const count = z.number().int().min(0).max(2_147_483_647)
const usd = z.number().min(0).max(999_999)

const lineSchema = z.object({
  agent_key: z.string().min(1).max(200),
  agent_label: z.string().min(1).max(200),
  model_id: z.string().min(1).max(200),
  input_tokens: count,
  output_tokens: count,
  cache_read_tokens: count,
  cache_write_tokens: count,
  requests: count,
})

// The strict contract, checked by the handler itself: a schema error must carry the REJECTED
// prefix like every other permanent error, so the SDK may not reject the call first (it would
// answer with a bare -32602 that the mod would retry forever). Registered loosely below.
const inputSchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().min(1).nullable(),
  anchor_task_id: z.string().min(1).nullable(),
  product_id: z.string().min(1).optional(),
  session_id: z.string().min(1).max(200),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().optional(),
  ended_reason: z.enum(ENDED_REASONS).optional(),
  active_ms: count.optional(),
  cost_start_usd: usd.nullable().optional(),
  cost_end_usd: usd.nullable().optional(),
  lines: z.array(lineSchema).max(50).optional(),
  mod_version: z.string().min(1).max(40),
})

type RecordUsageSegmentInput = z.infer<typeof inputSchema>

const registeredSchema = z.object({}).passthrough()

function endedReasonToDb(reason: (typeof ENDED_REASONS)[number]): UsageEndedReason {
  return OWN_REASONS[reason] ?? (taskStatusFromApi(reason) as UsageEndedReason)
}

// The closing part of a message, or null for a header.
function closing(input: RecordUsageSegmentInput) {
  if (input.ended_at === undefined) return null
  const start = input.cost_start_usd ?? null
  const end = input.cost_end_usd ?? null
  return {
    ended_at: new Date(input.ended_at),
    ended_reason: endedReasonToDb(input.ended_reason!),
    active_ms: input.active_ms ?? 0,
    reported_cost_usd: start === null || end === null ? null : (end - start).toFixed(4),
    lines: (input.lines ?? []).map((line) => ({ ...line })),
  }
}

function validate(input: RecordUsageSegmentInput): string | null {
  if (input.anchor_task_id === null) {
    if (input.task_id !== null) return 'a task segment needs anchor_task_id = task_id'
    if (!input.product_id) return 'a product segment (anchor_task_id null) needs product_id'
  } else if (input.task_id !== null && input.task_id !== input.anchor_task_id) {
    return 'anchor_task_id must equal task_id for a task segment'
  }
  if ((input.ended_at === undefined) !== (input.ended_reason === undefined)) {
    return 'ended_at and ended_reason come together'
  }
  if (input.ended_at !== undefined && new Date(input.ended_at) < new Date(input.started_at)) {
    return 'ended_at is before started_at'
  }
  const keys = new Set((input.lines ?? []).map((line) => `${line.agent_key}\u0000${line.model_id}`))
  if (keys.size !== (input.lines ?? []).length) return 'duplicate line for one agent_key and model_id'
  return null
}

const isUniqueViolation = (error: unknown) =>
  driverAdapterCause(error)?.originalCode === UNIQUE_VIOLATION ||
  (error as { code?: unknown } | null)?.code === 'P2002'

async function closeOpen(id: string, close: NonNullable<ReturnType<typeof closing>>): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // The row lock makes a concurrent second closing wait and then match nothing.
    const { count: closed } = await tx.usageSegment.updateMany({
      where: { id, ended_at: null },
      data: {
        ended_at: close.ended_at,
        ended_reason: close.ended_reason,
        active_ms: close.active_ms,
        reported_cost_usd: close.reported_cost_usd,
      },
    })
    if (closed === 0) return false
    await tx.usageLine.deleteMany({ where: { segment_id: id } })
    if (close.lines.length > 0) {
      await tx.usageLine.createMany({ data: close.lines.map((line) => ({ ...line, segment_id: id })) })
    }
    return true
  })
}

async function create(
  input: RecordUsageSegmentInput,
  userId: string,
  close: ReturnType<typeof closing>,
  scope: { product_id: string; sprint_id: string | null },
  retried: boolean,
): Promise<CallToolResult> {
  try {
    await prisma.usageSegment.create({
      data: {
        id: input.id,
        user_id: userId,
        product_id: scope.product_id,
        sprint_id: scope.sprint_id,
        task_id: input.task_id,
        anchor_task_id: input.anchor_task_id,
        session_id: input.session_id,
        started_at: new Date(input.started_at),
        mod_version: input.mod_version,
        ...(close && {
          ended_at: close.ended_at,
          ended_reason: close.ended_reason,
          active_ms: close.active_ms,
          reported_cost_usd: close.reported_cost_usd,
          lines: { create: close.lines },
        }),
      },
    })
  } catch (error) {
    // The same id was created concurrently (a retried message): handle it as existing.
    if (!retried && isUniqueViolation(error)) return record(input, userId, true)
    throw error
  }
  return toolJson({ id: input.id, state: close ? 'closed' : 'open', effect: 'created' })
}

async function record(input: RecordUsageSegmentInput, userId: string, retried = false): Promise<CallToolResult> {
  const close = closing(input)
  const existing = await prisma.usageSegment.findUnique({
    where: { id: input.id },
    select: { user_id: true, product_id: true, started_at: true, ended_at: true },
  })

  if (existing) {
    // (1) ownership and access before any lifecycle rule (RR4-6).
    if (existing.user_id !== userId || !(await userCanAccessProduct(existing.product_id, userId))) {
      return toolError(`${REJECTED}: segment ${input.id} belongs to another user or product`)
    }
    // (2) lifecycle.
    if (existing.ended_at !== null || close === null) {
      return toolJson({ id: input.id, state: existing.ended_at ? 'closed' : 'open', effect: 'none' })
    }
    // The stored start counts, not the one in this message (spec §6: ended_at ≥ started_at).
    if (close.ended_at < existing.started_at) {
      return toolError(`${REJECTED}: ended_at is before the stored started_at`)
    }
    const closed = await closeOpen(input.id, close)
    return toolJson({ id: input.id, state: 'closed', effect: closed ? 'closed' : 'none' })
  }

  if (input.anchor_task_id === null) {
    // Product segment (M47): no sprint, no task; the product comes from the input, checked here.
    const ref = await resolveProductRef(input.product_id!, userId)
    if ('error' in ref || !(await userCanAccessProduct(ref.id, userId))) {
      return toolError(`${REJECTED}: product ${input.product_id} not found or not accessible`)
    }
    return create(input, userId, close, { product_id: ref.id, sprint_id: null }, retried)
  }

  const anchor = await prisma.task.findUnique({
    where: { id: input.anchor_task_id },
    select: { product_id: true, sprint_id: true },
  })
  if (!anchor || !(await userCanAccessProduct(anchor.product_id, userId))) {
    return toolError(`${REJECTED}: task ${input.anchor_task_id} not found or not accessible`)
  }
  if (anchor.sprint_id === null) {
    return toolError(`${REJECTED}: task ${input.anchor_task_id} has no sprint`)
  }

  return create(input, userId, close, { product_id: anchor.product_id, sprint_id: anchor.sprint_id }, retried)
}

export async function handleRecordUsageSegment(raw: unknown) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const parsed = inputSchema.safeParse(raw)
    if (!parsed.success) return toolError(`${REJECTED}: ${formatZodError(parsed.error)}`)
    const invalid = validate(parsed.data)
    if (invalid) return toolError(`${REJECTED}: ${invalid}`)
    return record(parsed.data, auth.userId)
  })
}

export function registerRecordUsageSegmentTool(server: McpServer) {
  server.registerTool(
    'record_usage_segment',
    {
      title: 'Record usage segment',
      description:
        'Store one usage segment of an interactive Claude Code session (IDEA-235, written by the usage-ledger mod). Fields: id (uuid), task_id (string or null for overhead), anchor_task_id (string or null), product_id (optional), session_id, started_at (ISO), mod_version; to close also ended_at (ISO), ended_reason, active_ms, cost_start_usd, cost_end_usd, lines[{agent_key, agent_label, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests}] (max 50). A header (no ended_at) opens the segment and fixes owner, product and sprint from anchor_task_id; a closing message (ended_at, ended_reason, active_ms, cost_start_usd/cost_end_usd, lines) closes it once. Repeats and messages on a closed segment succeed without effect. task_id null = sprint overhead. `anchor_task_id` null with `product_id` (id or code) records a product-level segment: no sprint, no task (M47). Three scopes: task, sprint overhead, product. ended_reason uses API spelling (done, todo, review, failed, excluded, switched, session_end, untracked). Errors starting with USAGE_SEGMENT_REJECTED are permanent. Forbidden for demo accounts.',
      inputSchema: registeredSchema,
    },
    handleRecordUsageSegment,
  )
}
