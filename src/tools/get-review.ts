// src/tools/get-review.ts
// Leest het gepersisteerde review-verdict + findings voor een review-job uit de
// generieke ReviewLog. Drie toestanden: 'reviewed' (rij aanwezig), 'pending'
// (job nog QUEUED/CLAIMED/RUNNING) of 'no_verdict' (job terminaal zonder rij —
// bv. een review die faalde vóór het verdict). Een PR-COMMENT was hier ooit het
// schoolvoorbeeld, maar die persisteert sinds de COMMENT-enum wél.
// Scope: zelfde product-gescoopte 404 als get_job_status.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({ job_id: z.string().min(1) })

const ACTIVE_STATUSES = new Set(['QUEUED', 'CLAIMED', 'RUNNING'])

export async function handleGetReview(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const { job_id } = inputSchema.parse(input)
    const auth = await getAuth()
    const job = await prisma.claudeJob.findUnique({
      where: { id: job_id },
      select: { id: true, kind: true, status: true, product_id: true, pr_url: true, summary: true },
    })
    if (!job || !(await userCanAccessProduct(job.product_id, auth.userId))) {
      return toolError(`Job ${job_id} not found`)
    }
    const log = await prisma.reviewLog.findUnique({
      where: { review_job_id: job_id },
      select: {
        verdict: true, summary: true, findings: true, created_at: true,
        doc_id: true, doc_revision_id: true, task_id: true,
        sprint_task_execution_id: true, idea_id: true, pr_commit_id: true,
      },
    })
    if (log) {
      return toolJson({
        job_id, kind: job.kind, job_status: job.status, state: 'reviewed',
        verdict: log.verdict, summary: log.summary, findings: log.findings,
        target: {
          doc_id: log.doc_id, doc_revision_id: log.doc_revision_id,
          task_id: log.task_id, sprint_task_execution_id: log.sprint_task_execution_id,
          idea_id: log.idea_id, pr_url: job.pr_url, pr_commit_id: log.pr_commit_id,
        },
        created_at: log.created_at,
      })
    }
    // Spec §5.D: neem job.summary mee zodat de client 'klaar zonder verdict'
    // (bv. een PR-COMMENT) kan scheiden van een nog-lopende job.
    return toolJson({
      job_id, kind: job.kind, job_status: job.status,
      state: ACTIVE_STATUSES.has(job.status) ? 'pending' : 'no_verdict',
      verdict: null,
      summary: job.summary,
    })
  })
}

export function registerGetReviewTool(server: McpServer) {
  server.registerTool(
    'get_review',
    {
      title: 'Get a review verdict',
      description:
        'Read the persisted verdict + findings for a review job (SPEC_REVIEW/' +
        'TASK_REVIEW/PR_REVIEW/IDEA_REVIEW_PLAN) from the unified ReviewLog. ' +
        'Returns state reviewed|pending|no_verdict. Scoped: only jobs of ' +
        'accessible products (same 404 as get_job_status).',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => handleGetReview(input),
  )
}
