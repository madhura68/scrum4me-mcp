// M20 idea-plan-review-loop: keten-helpers voor de submit_review /
// update_idea_plan_md side-effects. Ronde-administratie leeft in
// orchestration_key (idea:{id}:plan-loop:r{n}); idempotentie via de
// composiet-unique (created_by_job_id, orchestration_key).
import { Prisma } from '@prisma/client'

const LOOP_KEY_RE = /^idea:.+:plan-loop:r(\d+)$/

export function parseLoopRound(key: string | null | undefined): number {
  const m = key?.match(LOOP_KEY_RE)
  return m ? Number.parseInt(m[1], 10) : 0
}

export function loopKey(ideaId: string, round: number): string {
  return `idea:${ideaId}:plan-loop:r${round}`
}

const LOOP_KINDS = ['IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN'] as const
const ACTIVE = ['QUEUED', 'CLAIMED', 'RUNNING'] as const

// Kind-gescopete active-job-check; sluit de triggerende (nog-RUNNING) job uit.
export async function findActiveLoopJob(
  tx: Prisma.TransactionClient,
  ideaId: string,
  excludeJobId: string | null,
): Promise<{ id: string; kind: string } | null> {
  return tx.claudeJob.findFirst({
    where: {
      idea_id: ideaId,
      kind: { in: [...LOOP_KINDS] },
      status: { in: [...ACTIVE] },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    select: { id: true, kind: true },
  })
}

// Row-lock op het idee binnen de lopende transactie (dispatch-guard, spec §4).
export async function lockIdeaRow(tx: Prisma.TransactionClient, ideaId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM ideas WHERE id = ${ideaId} FOR UPDATE`
}

// Dedup-detectie: composiet-unique (created_by_job_id, orchestration_key).
export function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

// Dual-write: verdict → idea.plan_review_log in de bestaande viewer-shape
// (components/ideas/review-log-viewer.tsx: rounds[], approval.status).
type Verdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED'
type Finding = { severity: string; message: string; ref?: string }

type PlanReviewLog = {
  plan_file?: string
  created_at?: string
  rounds: unknown[]
  approval: { status: 'pending' | 'approved' | 'rejected'; timestamp?: string }
  summary: string
}

function severityToIssue(s: string): 'error' | 'warning' | 'info' {
  if (/blocker|major/i.test(s)) return 'error'
  if (/minor/i.test(s)) return 'warning'
  return 'info'
}

export function appendPlanReviewRound(
  existing: unknown,
  input: {
    round: number
    verdict: Verdict
    model: string
    findings: Finding[]
    summary: string
    timestamp: string
  },
): PlanReviewLog {
  const base =
    existing && typeof existing === 'object' && Array.isArray((existing as { rounds?: unknown[] }).rounds)
      ? (existing as { plan_file?: string; created_at?: string; rounds: unknown[] })
      : { plan_file: '', created_at: input.timestamp, rounds: [] as unknown[] }

  return {
    plan_file: base.plan_file ?? '',
    created_at: base.created_at ?? input.timestamp,
    rounds: [
      ...base.rounds,
      {
        round: input.round,
        model: input.model,
        role: 'Adversarial review',
        focus: 'GO/NO-GO',
        issues: input.findings.map((f) => ({
          category: 'logic',
          severity: severityToIssue(f.severity),
          suggestion: f.ref ? `${f.ref}: ${f.message}` : f.message,
        })),
        score: input.verdict === 'APPROVED' ? 100 : input.verdict === 'CHANGES_REQUESTED' ? 50 : 0,
        plan_diff_lines: 0,
        converged: input.verdict === 'APPROVED',
        timestamp: input.timestamp,
      },
    ],
    approval: {
      status:
        input.verdict === 'APPROVED'
          ? 'approved'
          : input.verdict === 'REJECTED'
            ? 'rejected'
            : 'pending',
      ...(input.verdict !== 'CHANGES_REQUESTED' ? { timestamp: input.timestamp } : {}),
    },
    summary: input.summary,
  }
}
