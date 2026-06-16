// src/lib/upsert-review-log.ts
// Gedeelde sink: één ReviewLog-rij per review-job (upsert op review_job_id @unique →
// retry-idempotent). Gebruikt door submit_review, post_pr_review en
// update_idea_plan_reviewed. Pins zijn de per-kind targets.
import type { Prisma, ReviewVerdict, ClaudeJobKind } from '@prisma/client'
import { prisma } from '../prisma.js'

export type ReviewFinding = { severity: string; ref?: string; message: string }

export type ReviewLogPins = {
  doc_id?: string | null
  doc_revision_id?: string | null
  task_id?: string | null
  sprint_task_execution_id?: string | null
  idea_id?: string | null
  pr_commit_id?: string | null
}

export async function upsertReviewLog(input: {
  review_job_id: string
  kind: ClaudeJobKind
  product_id: string
  verdict: ReviewVerdict
  findings: ReviewFinding[]
  summary: string
  pins?: ReviewLogPins
}): Promise<void> {
  const { review_job_id, kind, product_id, verdict, findings, summary, pins } = input
  const row = {
    kind,
    product_id,
    doc_id: pins?.doc_id ?? null,
    doc_revision_id: pins?.doc_revision_id ?? null,
    task_id: pins?.task_id ?? null,
    sprint_task_execution_id: pins?.sprint_task_execution_id ?? null,
    idea_id: pins?.idea_id ?? null,
    pr_commit_id: pins?.pr_commit_id ?? null,
    verdict,
    findings: findings as unknown as Prisma.InputJsonValue,
    summary,
  }
  await prisma.reviewLog.upsert({
    where: { review_job_id },
    create: { review_job_id, ...row },
    update: row,
  })
}
