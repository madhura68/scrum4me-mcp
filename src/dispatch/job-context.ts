import type { DispatchInput, DispatchProfileConfig } from '@shared/queue-dispatch.js'
import { prisma } from '../prisma.js'
import { getKindPromptText } from '../lib/kind-prompts.js'

type WorkerRuntime = 'CLAUDE' | 'CODEX'
export const MANAGED_JOB_KINDS = ['QUEUE_TASK', 'QUEUE_REVIEW'] as const
export type ManagedJobKind = (typeof MANAGED_JOB_KINDS)[number]

/** The binding columns and the frozen job configuration — nothing that could
 * have moved since the request was authorized. */
const managedJobSelect = {
  id: true, kind: true, runtime: true, product_id: true,
  requested_model: true, requested_thinking_budget: true, requested_permission_mode: true,
  dispatch_request_id: true, dispatch_candidate_id: true,
} as const

export type ManagedJobContext = {
  job_id: string
  kind: ManagedJobKind
  source: 'COPILOT'
  status: 'claimed'
  managed: true
  dispatch: {
    request_id: string
    candidate_id: string | null
    generation: number | null
    route: string | null
    profile_revision_id: string | null
    profile: DispatchProfileConfig | null
    profile_sha256: string | null
    input: DispatchInput
    input_hash: string
    snapshot: unknown
    state: string
    source_artifacts: { key: string; artifact_id: string; sha256: string }[]
  }
  model_config: { model: string | null; thinking_budget: number | null; permission_mode: string | null; runtime: WorkerRuntime }
  product: { id: string }
  prompt_text: string
}

type ManagedJobRow = {
  id: string; kind: string; runtime: WorkerRuntime; product_id: string
  requested_model: string | null; requested_thinking_budget: number | null; requested_permission_mode: string | null
  dispatch_request_id: string | null; dispatch_candidate_id: string | null
}

/**
 * One primary-key lookup of the binding columns, run before any context is
 * built. It decides three things at once: whether this job is managed at all,
 * whether a managed kind is actually bound, and — for every other kind —
 * nothing, so the ordinary path (including its own managed-row guard) decides.
 *
 * A QUEUE_TASK/QUEUE_REVIEW without a dispatch request is refused here rather
 * than filled in from the surrounding records: an unbound managed kind has no
 * authorized contract, and there is nothing a model could safely be started on.
 */
export async function readManagedJobBinding(jobId: string): Promise<ManagedJobRow | null> {
  const job = await prisma.claudeJob.findUnique({ where: { id: jobId }, select: managedJobSelect }) as ManagedJobRow | null
  if (!job || !(MANAGED_JOB_KINDS as readonly string[]).includes(job.kind)) return null
  if (job.dispatch_request_id === null) throw new Error('DISPATCH_UNBOUND_JOB')
  return job
}

/**
 * Build the whole job context from the pinned dispatch rows. Deliberately no
 * Task, Story, PBI, Sprint, Idea or doc index: a free managed request has none,
 * and a bound one must see the snapshot it was authorized against rather than
 * whatever those records say today.
 */
export async function buildManagedJobContext(job: ManagedJobRow, runtime?: WorkerRuntime): Promise<ManagedJobContext> {
  const requestId = job.dispatch_request_id!
  const request = await prisma.queueDispatchRequest.findUnique({
    where: { id: requestId },
    select: { id: true, input: true, input_hash: true, snapshot: true, state: true },
  })
  if (!request) throw new Error('DISPATCH_UNBOUND_JOB')
  const candidate = job.dispatch_candidate_id
    ? await prisma.queueDispatchCandidate.findUnique({
      where: { id: job.dispatch_candidate_id },
      select: { id: true, generation: true, route: true, profile_revision_id: true, profile: { select: { config: true, sha256: true } } },
    })
    : null
  const artifacts = await prisma.queueDispatchArtifact.findMany({
    where: { request_id: requestId, attempt_id: null },
    orderBy: { key: 'asc' },
    select: { id: true, key: true, sha256: true },
  })
  const effectiveRuntime = runtime ?? job.runtime
  const kind = job.kind as ManagedJobKind
  return {
    job_id: job.id, kind, source: 'COPILOT', status: 'claimed', managed: true,
    dispatch: {
      request_id: requestId,
      candidate_id: candidate?.id ?? null,
      generation: candidate?.generation ?? null,
      route: candidate?.route ?? null,
      profile_revision_id: candidate?.profile_revision_id ?? null,
      profile: (candidate?.profile?.config ?? null) as DispatchProfileConfig | null,
      profile_sha256: candidate?.profile?.sha256 ?? null,
      input: request.input as unknown as DispatchInput,
      input_hash: request.input_hash,
      snapshot: request.snapshot,
      state: request.state,
      source_artifacts: artifacts.map(a => ({ key: a.key, artifact_id: a.id, sha256: a.sha256 })),
    },
    model_config: {
      model: job.requested_model, thinking_budget: job.requested_thinking_budget,
      permission_mode: job.requested_permission_mode, runtime: effectiveRuntime,
    },
    product: { id: job.product_id },
    prompt_text: getKindPromptText(kind, effectiveRuntime),
  }
}
