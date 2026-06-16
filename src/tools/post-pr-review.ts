// MCP-tool: post een Forgejo PR-review-state na een PR_REVIEW-job en schrijft
// een verdict-trace naar ClaudeJob.summary. De job is de autoriteit: alleen
// een PR_REVIEW-job met een opgeslagen pr_url mag posten, en alléén naar díe
// PR. Een Forgejo-post-fout faalt de tool (geen stille review-verlies).
// Model: update-idea-plan-reviewed.ts.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { postPullRequestReview } from '../git/pr.js'
import { upsertReviewLog, type ReviewFinding } from '../lib/upsert-review-log.js'

export const inputSchema = z.object({
  job_id: z.string().min(1),
  pr_url: z.string().min(1),
  event: z.enum(['APPROVED', 'REQUEST_CHANGES', 'COMMENT'] as const),
  body: z.string().min(1).max(65_535),
  commit_id: z.string().optional(),
  review_log: z.object({}).passthrough().optional(),
})

export async function handlePostPrReview(
  { job_id, pr_url, event, body, commit_id, review_log }: z.infer<typeof inputSchema>,
) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const job = await prisma.claudeJob.findUnique({
      where: { id: job_id },
      select: { id: true, user_id: true, pr_url: true, kind: true, product_id: true },
    })
    if (!job || job.user_id !== auth.userId) {
      return toolError('Job not found')
    }
    if (job.kind !== 'PR_REVIEW') {
      return toolError('Job is not a PR_REVIEW job')
    }
    if (!job.pr_url) {
      return toolError('Job has no pr_url')
    }
    if (pr_url !== job.pr_url) {
      return toolError(`pr_url mismatch: job is bound to ${job.pr_url}`)
    }

    const posted = await postPullRequestReview({ prUrl: job.pr_url, event, body, commitId: commit_id })
    if ('error' in posted) {
      // Bewust falen: geen stille review-verlies; de prompt faalt dan de job.
      return toolError(`post_pr_review failed: ${posted.error}`)
    }

    // review_log is passthrough-traceering: ClaudeJob heeft geen log-tabel
    // (Phase 2: geen nieuwe kolom) — de Forgejo-review zelf is de primaire
    // sink. We verrijken wel de summary-trace met de findings-telling.
    const findings = Array.isArray((review_log as { findings?: unknown } | undefined)?.findings)
      ? ((review_log as { findings: unknown[] }).findings.length)
      : null
    const findingsSuffix = findings !== null ? ` (${findings} findings)` : ''

    await prisma.claudeJob.update({
      where: { id: job_id },
      data: { summary: `PR review ${event}${findingsSuffix}: ${body.slice(0, 280)}` },
    })

    // Unified ReviewLog: alleen een echt verdict (APPROVED/REQUEST_CHANGES) persisteert;
    // COMMENT is geen verdict. De Forgejo-post is de primaire actie en is al geslaagd.
    if (event !== 'COMMENT') {
      const raw = (review_log as { findings?: unknown } | undefined)?.findings
      const findings: ReviewFinding[] = Array.isArray(raw) ? (raw as ReviewFinding[]) : []
      await upsertReviewLog({
        review_job_id: job_id,
        kind: 'PR_REVIEW',
        product_id: job.product_id,
        verdict: event === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED',
        findings,
        summary: body,
        pins: { pr_commit_id: commit_id ?? null },
      })
    }

    return toolJson({ ok: true, event, review_id: posted.reviewId ?? null })
  })
}

export function registerPostPrReviewTool(server: McpServer) {
  server.registerTool(
    'post_pr_review',
    {
      title: 'Post a PR review verdict',
      description:
        'Post a Forgejo PR review (event APPROVED/REQUEST_CHANGES/COMMENT) for a ' +
        'PR_REVIEW job and record a verdict-trace on the job. The job is the ' +
        'authority: it must be a PR_REVIEW job with a stored pr_url, and the ' +
        'input pr_url must match. A Forgejo failure fails the tool (never a ' +
        'silent success). Forbidden for demo accounts.',
      inputSchema,
    },
    handlePostPrReview,
  )
}
