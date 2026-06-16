// MCP-tool: writes the review-log result after an IDEA_REVIEW_PLAN job and
// transitions idea.status. Only an explicit approval_status='approved' moves
// the idea to PLAN_REVIEWED; anything else (rejected, pending, or omitted)
// goes to PLAN_REVIEW_FAILED — a human must then decide. The tool never
// silently approves.
//
// Called by the worker as the final step of a review-plan session.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { upsertReviewLog, type ReviewFinding } from '../lib/upsert-review-log.js'

export const inputSchema = z.object({
  idea_id: z.string().min(1),
  job_id: z.string().min(1),
  review_log: z.object({}).passthrough(), // Full ReviewLog from orchestrator (JSON object)
  approval_status: z
    .enum(['pending', 'approved', 'rejected'] as const)
    .optional(),
})

export async function handleUpdateIdeaPlanReviewed(
  { idea_id, job_id, review_log, approval_status }: z.infer<typeof inputSchema>,
) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const job = await prisma.claudeJob.findUnique({
      where: { id: job_id },
      select: { id: true, user_id: true, kind: true, idea_id: true, product_id: true },
    })
    if (!job || job.user_id !== auth.userId || job.idea_id !== idea_id) {
      return toolError('Job not found')
    }
    if (job.kind !== 'IDEA_REVIEW_PLAN') {
      return toolError('Job is not an IDEA_REVIEW_PLAN job')
    }

    // Alleen een expliciete 'approved' brengt het idee naar PLAN_REVIEWED.
    // 'rejected', 'pending' én een weggelaten approval_status betekenen
    // allemaal "niet auto-goedgekeurd — mens moet beslissen" en gaan naar
    // PLAN_REVIEW_FAILED. Nooit stilzwijgend goedkeuren (de vorige
    // `: 'PLAN_REVIEWED'`-default deed dat wel bij pending/undefined).
    const nextStatus =
      approval_status === 'approved' ? 'PLAN_REVIEWED' : 'PLAN_REVIEW_FAILED'

    // Log summary metrics from review_log
    const logSummary = buildReviewLogSummary(review_log)

    const result = await prisma.$transaction([
      prisma.idea.update({
        where: { id: idea_id },
        data: {
          plan_review_log: review_log as any,
          reviewed_at: new Date(),
          status: nextStatus,
        },
        select: { id: true, status: true, code: true },
      }),
      prisma.ideaLog.create({
        data: {
          idea_id,
          type: 'PLAN_REVIEW_RESULT',
          content: logSummary.summary,
          metadata: {
            approval_status,
            convergence_status: logSummary.convergence_status,
            final_score: logSummary.final_score,
            rounds_completed: logSummary.rounds_completed,
          },
        },
      }),
    ])

    const verdict =
      approval_status === 'approved' ? 'APPROVED'
      : approval_status === 'rejected' ? 'REJECTED'
      : 'CHANGES_REQUESTED'
    const raw = (review_log as { findings?: unknown }).findings
    const findings: ReviewFinding[] = Array.isArray(raw) ? (raw as ReviewFinding[]) : []
    await upsertReviewLog({
      review_job_id: job_id,
      kind: 'IDEA_REVIEW_PLAN',
      product_id: job.product_id,
      verdict,
      findings,
      summary: logSummary.summary,
      pins: { idea_id },
    })

    return toolJson({
      ok: true,
      idea: result[0],
      review_log_summary: logSummary,
    })
  })
}

export function registerUpdateIdeaPlanReviewedTool(server: McpServer) {
  server.registerTool(
    'update_idea_plan_reviewed',
    {
      title: 'Mark plan as reviewed',
      description:
        'Save review-log after a plan review cycle and transition idea.status. ' +
        'Requires job_id (must be an IDEA_REVIEW_PLAN job owned by the caller ' +
        'and bound to the given idea_id). Writes a ReviewLog row. ' +
        'Only approval_status="approved" → PLAN_REVIEWED; "rejected", "pending", ' +
        'or an omitted approval_status → PLAN_REVIEW_FAILED (needs manual ' +
        'approval — never silently approved). Forbidden for demo accounts.',
      inputSchema,
    },
    handleUpdateIdeaPlanReviewed,
  )
}

function buildReviewLogSummary(
  reviewLog: Record<string, any>,
): {
  summary: string
  convergence_status: string
  final_score: number
  rounds_completed: number
} {
  const rounds = Array.isArray(reviewLog.rounds) ? reviewLog.rounds : []
  const convergence = reviewLog.convergence || {}
  const finalScore =
    rounds.length > 0 ? rounds[rounds.length - 1].score ?? 0 : 0

  const convergenceStatus =
    convergence.stable_at_round !== undefined
      ? `stable at round ${convergence.stable_at_round}`
      : convergence.final_diff_pct !== undefined
        ? `${convergence.final_diff_pct}% diff`
        : 'pending'

  const summary =
    `Plan reviewed in ${rounds.length} rounds. ` +
    `Convergence: ${convergenceStatus}. ` +
    `Final score: ${finalScore}/100. ` +
    `Status: ${reviewLog.approval?.status || 'pending'}.`

  return {
    summary,
    convergence_status: convergenceStatus,
    final_score: finalScore,
    rounds_completed: rounds.length,
  }
}
