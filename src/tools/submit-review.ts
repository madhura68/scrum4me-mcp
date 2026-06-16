// MCP-tool: schrijft het verdict van een SPEC_REVIEW/TASK_REVIEW-job naar de
// generieke ReviewLog en zet een verdict-trace op ClaudeJob.summary. De job
// is de autoriteit: kind + target komen uit de jób, nooit uit de input.
// Upsert op review_job_id → retry-idempotent (1 verdict-rij per job; her-
// review-historie = meerdere jobs). Een DB-fout faalt de tool (geen stil
// verlies — Phase 2-principe). Model: post-pr-review.ts.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { upsertReviewLog } from '../lib/upsert-review-log.js'

export const inputSchema = z.object({
  job_id: z.string().min(1),
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'] as const),
  findings: z.array(z.object({
    severity: z.string().min(1),
    ref: z.string().optional(),
    message: z.string().min(1),
  })),
  summary: z.string().min(1).max(65_535),
  review_log: z.object({}).passthrough().optional(),
})

export async function handleSubmitReview(
  { job_id, verdict, findings, summary }: z.infer<typeof inputSchema>,
) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const job = await prisma.claudeJob.findUnique({
      where: { id: job_id },
      select: {
        id: true,
        user_id: true,
        kind: true,
        product_id: true,
        doc_id: true,
        task_id: true,
        doc: { select: { current_revision_id: true } },
      },
    })
    if (!job || job.user_id !== auth.userId) {
      return toolError('Job not found')
    }
    if (job.kind !== 'SPEC_REVIEW' && job.kind !== 'TASK_REVIEW') {
      return toolError('Job is not a SPEC_REVIEW/TASK_REVIEW job')
    }

    let docRevisionId: string | null = null
    let executionId: string | null = null
    if (job.kind === 'SPEC_REVIEW') {
      if (!job.doc_id) return toolError('Job has no doc_id')
      // Revisie-pin op submit-moment (spec §6): de dán geldende current_revision_id.
      docRevisionId = job.doc?.current_revision_id ?? null
    } else {
      if (!job.task_id) return toolError('Job has no task_id')
      const execution = await prisma.sprintTaskExecution.findFirst({
        where: { task_id: job.task_id, status: 'DONE' },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      })
      executionId = execution?.id ?? null
    }

    await upsertReviewLog({
      review_job_id: job.id,
      kind: job.kind,
      product_id: job.product_id,
      verdict,
      findings,
      summary,
      pins: {
        doc_id: job.kind === 'SPEC_REVIEW' ? job.doc_id : null,
        doc_revision_id: docRevisionId,
        task_id: job.kind === 'TASK_REVIEW' ? job.task_id : null,
        sprint_task_execution_id: executionId,
      },
    })

    await prisma.claudeJob.update({
      where: { id: job.id },
      data: { summary: `${job.kind} ${verdict} (${findings.length} findings): ${summary.slice(0, 280)}` },
    })

    return toolJson({ ok: true, verdict, findings_count: findings.length })
  })
}

export function registerSubmitReviewTool(server: McpServer) {
  server.registerTool(
    'submit_review',
    {
      title: 'Submit a review verdict (ReviewLog)',
      description:
        'Persist the verdict of a SPEC_REVIEW/TASK_REVIEW job into the generic ' +
        'ReviewLog and record a verdict-trace on the job. The job is the ' +
        'authority: kind and target (doc_id/task_id) come from the job, never ' +
        'from the input. Idempotent per job (upsert on review_job_id). A DB ' +
        'failure fails the tool (never a silent success). Forbidden for demo accounts.',
      inputSchema,
    },
    handleSubmitReview,
  )
}
