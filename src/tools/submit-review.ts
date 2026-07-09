// MCP-tool: schrijft het verdict van een SPEC_REVIEW/TASK_REVIEW/IDEA_REVIEW_PLAN-
// job naar de generieke ReviewLog en zet een verdict-trace op ClaudeJob.summary.
// De job is de autoriteit: kind + target komen uit de jób, nooit uit de input.
//
// SPEC/TASK: upsert op review_job_id → retry-idempotent (1 verdict-rij per job).
// IDEA_REVIEW_PLAN (M20 plan-review-loop): pure adversarial review. Het verdict
// stuurt de keten atomair aan — de ReviewLog-rij binnen dezelfde transactie is
// de idempotentie-guard (rollback bij een side-effect-fout → retry verwerkt
// alsnog volledig; gecommitte rij → retry is no-op):
//   APPROVED           → PLAN_REVIEWED (+ auto-materialize bij toggle) + hardstop
//   CHANGES_REQUESTED  → PLANNING + revisie-job r{n+1} (toggle-uit → PLAN_REVIEW_FAILED)
//   REJECTED           → PLAN_REVIEW_FAILED + escalatie-vraag aan de gebruiker

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Prisma } from '@prisma/client'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { upsertReviewLog } from '../lib/upsert-review-log.js'
import {
  appendPlanReviewRound,
  findActiveLoopJob,
  lockIdeaRow,
  loopKey,
  parseLoopRound,
  findActiveSpecLoopJob,
  specLoopKey,
} from '../lib/idea-plan-loop.js'
import { materializeIdeaPlan } from '../lib/idea-materialize.js'
import { notifyJobEnqueued } from '../lib/dispatch/notify.js'
import { triggerPush } from '../lib/push-trigger.js'

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

type SubmitReviewInput = z.infer<typeof inputSchema>

// Escalatie-vraag ín de verdict-transactie (dezelfde DB). Shape gelijk aan
// ask-user-question.ts (ClaudeQuestion.status is een verplicht String-veld).
// De web-push volgt post-commit.
async function createIdeaEscalationQuestion(
  tx: Prisma.TransactionClient,
  params: { ideaId: string; productId: string; userId: string; question: string },
): Promise<void> {
  await tx.claudeQuestion.create({
    data: {
      story_id: null,
      idea_id: params.ideaId,
      task_id: null,
      product_id: params.productId,
      asked_by: params.userId,
      question: params.question,
      status: 'open',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })
}

type IdeaReviewJob = {
  id: string
  user_id: string
  product_id: string
  runtime: string
  orchestration_key: string | null
  status: string
  claimed_by_token_id: string | null
  // M23 pin-retrofit: de review-job draagt sinds de dispatch-pin ook het
  // beoordeelde doc + de exacte revisie; null voor pre-M23-jobs (legacy).
  doc_id?: string | null
  doc_revision_id?: string | null
  created_by_job_id?: string | null
  idea: { id: string; status: string; plan_review_log: unknown } | null
  product: { auto_plan_review: boolean; auto_materialize_plan: boolean } | null
}

type VerdictOutcome = {
  // 'stale' = de review-job is niet meer actief (user-cancel / reclaim / terminaal);
  // het verdict wordt bewust NIET toegepast (noodrem, zie applyIdeaReviewVerdict).
  // 'plan-started' (M23) = spec APPROVED → IDEA_MAKE_PLAN gedispatcht.
  outcome: 'already-processed' | 'revision' | 'manual-stop' | 'approved' | 'rejected' | 'stale' | 'plan-started'
  revisionJobId?: string
}

// Een review-verdict landt alleen als DEZE worker de job nog steeds actief
// geclaimd heeft (CLAIMED/RUNNING + eigen token). Zo niet — user-cancel, reclaim
// onder een ander token, of terminaal — dan is de review gestopt en wordt het
// verdict verworpen. Spiegelt update-job-status.ts:919/931.
function reviewStillActive(
  job: { status: string; claimed_by_token_id: string | null } | null,
  callerTokenId: string | undefined,
): boolean {
  return (
    !!job &&
    job.claimed_by_token_id === callerTokenId &&
    (job.status === 'CLAIMED' || job.status === 'RUNNING')
  )
}

// Alles-of-niets: ReviewLog + status + vervolg-job/vraag in één transactie.
// De in-tx guard op de ReviewLog-rij is de idempotentie. Auto-materialize draait
// bewust ná commit (buiten deze functie).
async function applyIdeaReviewVerdict(
  job: IdeaReviewJob,
  input: SubmitReviewInput,
  callerTokenId: string | undefined,
): Promise<VerdictOutcome> {
  const ideaId = job.idea!.id
  const round = Math.max(parseLoopRound(job.orchestration_key), 1)
  const now = new Date()
  const planReviewLog = appendPlanReviewRound(job.idea!.plan_review_log, {
    round,
    verdict: input.verdict,
    model: job.runtime === 'CODEX' ? 'codex' : 'claude',
    findings: input.findings,
    summary: input.summary,
    timestamp: now.toISOString(),
  })
  const planReviewLogJson = planReviewLog as unknown as Prisma.InputJsonValue
  const findingsJson = input.findings as unknown as Prisma.InputJsonValue

  return prisma.$transaction(async (tx) => {
    await lockIdeaRow(tx, ideaId)
    const existing = await tx.reviewLog.findUnique({
      where: { review_job_id: job.id },
      select: { id: true },
    })
    if (existing) return { outcome: 'already-processed' as const }

    // Noodrem-guard (spiegelt update-job-status.ts:919/922/931): een verdict landt
    // alleen als DEZE worker de job nog steeds actief geclaimd heeft. Annuleerde de
    // gebruiker de review (job → CANCELLED) terwijl de worker nog draaide, of is de
    // job onder een ander token opnieuw geclaimd / terminaal, dan wordt het verdict
    // verworpen — de keten blijft gestopt op de door de cancel gezette idee-status.
    // De job-status wordt hier binnen de tx (na de idee-lock) her-lezen omdat de
    // cancel ná de outer findUnique kan zijn gecommit.
    const live = await tx.claudeJob.findUnique({
      where: { id: job.id },
      select: { status: true, claimed_by_token_id: true },
    })
    if (!reviewStillActive(live, callerTokenId)) {
      await tx.ideaLog.create({
        data: {
          idea_id: ideaId,
          type: 'PLAN_REVIEW_RESULT',
          content: `Review r${round}: verdict ${input.verdict} verworpen — review niet meer actief (${live?.status ?? 'verwijderd'}); de loop is gestopt`,
          metadata: { job_id: job.id, verdict: input.verdict, round, job_status: live?.status ?? null },
        },
      })
      return { outcome: 'stale' as const }
    }

    await tx.reviewLog.create({
      data: {
        review_job_id: job.id,
        kind: 'IDEA_REVIEW_PLAN',
        product_id: job.product_id,
        idea_id: ideaId,
        // M23: pin van dispatch-moment mee de log in (null = pre-M23 legacy;
        // resolvePlanSource behandelt dat als legacy-goedkeuring van current).
        doc_id: job.doc_id ?? null,
        doc_revision_id: job.doc_revision_id ?? null,
        verdict: input.verdict,
        findings: findingsJson,
        summary: input.summary,
      },
    })

    if (input.verdict === 'CHANGES_REQUESTED' && job.product?.auto_plan_review) {
      // Zelfde uitsluiting als de spec-loop: de maker die deze review dispatchte
      // kan nog CLAIMED zijn en mag de revisie niet blokkeren.
      const active = await findActiveLoopJob(tx, ideaId, [job.id, job.created_by_job_id])
      if (active) {
        // Randgeval: een andere loop-job is al actief — geen nieuwe revisie én
        // geen status-claim die niet waar is; alleen waarheidsgetrouw loggen.
        await tx.idea.update({
          where: { id: ideaId },
          data: { plan_review_log: planReviewLogJson, reviewed_at: now },
        })
        await tx.ideaLog.create({
          data: {
            idea_id: ideaId,
            type: 'PLAN_REVIEW_RESULT',
            content: `Review r${round}: CHANGES_REQUESTED — bestaande loop-job ${active.kind} actief, geen nieuwe revisie gequeued`,
            metadata: { job_id: job.id, verdict: input.verdict, round, active_job_id: active.id },
          },
        })
        return { outcome: 'already-processed' as const }
      }
      const revision = await tx.claudeJob.create({
        data: {
          user_id: job.user_id,
          product_id: job.product_id,
          idea_id: ideaId,
          kind: 'IDEA_MAKE_PLAN',
          status: 'QUEUED',
          source: 'SYSTEM',
          created_by_job_id: job.id,
          orchestration_key: loopKey(ideaId, round + 1),
          summary: `Plan-revisie r${round + 1} na review r${round}`,
        },
        select: { id: true },
      })
      await tx.idea.update({
        where: { id: ideaId },
        data: { status: 'PLANNING', plan_review_log: planReviewLogJson, reviewed_at: now },
      })
      await tx.ideaLog.create({
        data: {
          idea_id: ideaId,
          type: 'PLAN_REVIEW_RESULT',
          content: `Review r${round}: CHANGES_REQUESTED (${input.findings.length} findings) — revisie r${round + 1} queued`,
          metadata: { job_id: job.id, verdict: input.verdict, round },
        },
      })
      return { outcome: 'revision' as const, revisionJobId: revision.id }
    }

    if (input.verdict === 'CHANGES_REQUESTED') {
      // Toggle uit = handmatige review-flow (verdict landt, gebruiker beslist) —
      // géén auto-revisie; niet-approved → PLAN_REVIEW_FAILED.
      await tx.idea.update({
        where: { id: ideaId },
        data: { status: 'PLAN_REVIEW_FAILED', plan_review_log: planReviewLogJson, reviewed_at: now },
      })
      await tx.ideaLog.create({
        data: {
          idea_id: ideaId,
          type: 'PLAN_REVIEW_RESULT',
          content: `Review r${round}: CHANGES_REQUESTED (${input.findings.length} findings) — handmatige flow, geen auto-revisie`,
          metadata: { job_id: job.id, verdict: input.verdict, round },
        },
      })
      return { outcome: 'manual-stop' as const }
    }

    const nextStatus = input.verdict === 'APPROVED' ? 'PLAN_REVIEWED' : 'PLAN_REVIEW_FAILED'
    await tx.idea.update({
      where: { id: ideaId },
      data: { status: nextStatus, plan_review_log: planReviewLogJson, reviewed_at: now },
    })
    await tx.ideaLog.create({
      data: {
        idea_id: ideaId,
        type: 'PLAN_REVIEW_RESULT',
        content:
          input.verdict === 'APPROVED'
            ? `Review r${round}: APPROVED (GO)`
            : `Review r${round}: REJECTED — escalatie naar gebruiker`,
        metadata: { job_id: job.id, verdict: input.verdict, round },
      },
    })
    if (input.verdict === 'REJECTED') {
      await createIdeaEscalationQuestion(tx, {
        ideaId,
        productId: job.product_id,
        userId: job.user_id,
        question: `Codex wijst het plan fundamenteel af (r${round}): ${input.summary.slice(0, 400)} — hoe verder? (opnieuw plannen / plan handmatig bijwerken / afbreken)`,
      })
    }
    return { outcome: input.verdict === 'APPROVED' ? ('approved' as const) : ('rejected' as const) }
  })
}

// M23: pipeline-SPEC_REVIEW (job.idea gezet) — de spec-fase-tegenhanger van
// applyIdeaReviewVerdict, met dezelfde hardening: idea-lock, create-once,
// reviewStillActive-noodrem. Ad-hoc SPEC_REVIEW (zonder idea) raakt dit pad niet.
type SpecPipelineReviewJob = IdeaReviewJob & {
  doc_id: string | null
  doc_revision_id: string | null
}

async function applySpecReviewVerdict(
  job: SpecPipelineReviewJob,
  input: SubmitReviewInput,
  callerTokenId: string | undefined,
): Promise<VerdictOutcome> {
  const ideaId = job.idea!.id
  const round = Math.max(parseLoopRound(job.orchestration_key), 1)
  const findingsJson = input.findings as unknown as Prisma.InputJsonValue

  return prisma.$transaction(async (tx) => {
    await lockIdeaRow(tx, ideaId)
    const existing = await tx.reviewLog.findUnique({
      where: { review_job_id: job.id },
      select: { id: true },
    })
    if (existing) return { outcome: 'already-processed' as const }

    // Noodrem (M20-patroon): verdict landt alleen op een nog-actieve claim.
    const live = await tx.claudeJob.findUnique({
      where: { id: job.id },
      select: { status: true, claimed_by_token_id: true },
    })
    if (!reviewStillActive(live, callerTokenId)) {
      await tx.ideaLog.create({
        data: {
          idea_id: ideaId,
          type: 'JOB_EVENT',
          content: `Spec-review r${round}: verdict ${input.verdict} verworpen — review niet meer actief (${live?.status ?? 'verwijderd'})`,
          metadata: { job_id: job.id, verdict: input.verdict, round, job_status: live?.status ?? null },
        },
      })
      return { outcome: 'stale' as const }
    }

    await tx.reviewLog.create({
      data: {
        review_job_id: job.id,
        kind: 'SPEC_REVIEW',
        product_id: job.product_id,
        idea_id: ideaId,
        doc_id: job.doc_id,
        doc_revision_id: job.doc_revision_id, // pin van dispatch-moment
        verdict: input.verdict,
        findings: findingsJson,
        summary: input.summary,
      },
    })

    if (input.verdict === 'APPROVED') {
      // Doorstroom naar de bestaande M20-plan-loop.
      const j = await tx.claudeJob.create({
        data: {
          user_id: job.user_id,
          product_id: job.product_id,
          idea_id: ideaId,
          kind: 'IDEA_MAKE_PLAN',
          status: 'QUEUED',
          source: 'SYSTEM',
          created_by_job_id: job.id,
          orchestration_key: loopKey(ideaId, 1),
          summary: 'Plan-fase gestart na spec-approval (M23)',
        },
        select: { id: true },
      })
      await tx.idea.update({ where: { id: ideaId }, data: { status: 'PLANNING' } })
      await tx.ideaLog.create({
        data: {
          idea_id: ideaId,
          type: 'JOB_EVENT',
          content: `Spec-review r${round}: APPROVED — IDEA_MAKE_PLAN queued`,
          metadata: { job_id: job.id, round, next_job_id: j.id },
        },
      })
      return { outcome: 'plan-started' as const, revisionJobId: j.id }
    }

    if (input.verdict === 'CHANGES_REQUESTED') {
      // Sluit óók de maker uit die deze review dispatchte: die kan nog CLAIMED
      // zijn (verdict sneller dan maker-afsluiting) en is geen reden om de
      // revisie te skippen — zonder revisie hangt het idee op SPEC_REVIEWING.
      const active = await findActiveSpecLoopJob(tx, ideaId, [job.id, job.created_by_job_id])
      if (active) {
        await tx.ideaLog.create({
          data: {
            idea_id: ideaId,
            type: 'JOB_EVENT',
            content: `Spec-review r${round}: CHANGES_REQUESTED — bestaande spec-loop-job ${active.kind} actief, geen nieuwe revisie gequeued`,
            metadata: { job_id: job.id, round, active_job_id: active.id },
          },
        })
        return { outcome: 'already-processed' as const }
      }
      const revision = await tx.claudeJob.create({
        data: {
          user_id: job.user_id,
          product_id: job.product_id,
          idea_id: ideaId,
          kind: 'IDEA_REVISE_SPEC',
          status: 'QUEUED',
          source: 'SYSTEM',
          created_by_job_id: job.id,
          orchestration_key: specLoopKey(ideaId, round + 1),
          summary: `Spec-revisie r${round + 1} na CHANGES_REQUESTED`,
        },
        select: { id: true },
      })
      await tx.idea.update({ where: { id: ideaId }, data: { status: 'SPEC_DRAFTING' } })
      await tx.ideaLog.create({
        data: {
          idea_id: ideaId,
          type: 'JOB_EVENT',
          content: `Spec-review r${round}: CHANGES_REQUESTED (${input.findings.length} findings) — spec-revisie r${round + 1} queued`,
          metadata: { job_id: job.id, round },
        },
      })
      return { outcome: 'revision' as const, revisionJobId: revision.id }
    }

    // REJECTED — pipeline stopt; user beslist (retry of terug naar GRILLED).
    await tx.idea.update({ where: { id: ideaId }, data: { status: 'SPEC_FAILED' } })
    await tx.ideaLog.create({
      data: {
        idea_id: ideaId,
        type: 'JOB_EVENT',
        content: `Spec-review r${round}: REJECTED — escalatie naar gebruiker`,
        metadata: { job_id: job.id, round },
      },
    })
    await createIdeaEscalationQuestion(tx, {
      ideaId,
      productId: job.product_id,
      userId: job.user_id,
      question: `Codex wijst de spec fundamenteel af (r${round}): ${input.summary.slice(0, 400)} — hoe verder? (spec opnieuw maken / terug naar GRILLED / afbreken)`,
    })
    return { outcome: 'rejected' as const }
  })
}

export async function handleSubmitReview(
  { job_id, verdict, findings, summary }: SubmitReviewInput,
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
        runtime: true,
        orchestration_key: true,
        status: true,
        claimed_by_token_id: true,
        doc_id: true,
        doc_revision_id: true,
        created_by_job_id: true,
        task_id: true,
        doc: { select: { current_revision_id: true } },
        idea: { select: { id: true, status: true, plan_review_log: true } },
        product: { select: { auto_plan_review: true, auto_materialize_plan: true } },
      },
    })
    if (!job || job.user_id !== auth.userId) {
      return toolError('Job not found')
    }
    if (job.kind !== 'SPEC_REVIEW' && job.kind !== 'TASK_REVIEW' && job.kind !== 'IDEA_REVIEW_PLAN') {
      return toolError('Job is not a SPEC_REVIEW/TASK_REVIEW/IDEA_REVIEW_PLAN job')
    }

    // ── M20 idea-plan-review-loop ────────────────────────────────────────
    if (job.kind === 'IDEA_REVIEW_PLAN') {
      if (!job.idea) return toolError('Review job has no idea')
      const result = await applyIdeaReviewVerdict(
        job as IdeaReviewJob,
        { job_id, verdict, findings, summary },
        auth.tokenId,
      )

      // Post-commit side-effects (best-effort; falen breekt de review-afsluiting niet).
      if (result.outcome === 'revision' && result.revisionJobId) {
        await notifyJobEnqueued({
          job_id: result.revisionJobId,
          user_id: job.user_id,
          product_id: job.product_id,
          kind: 'IDEA_MAKE_PLAN',
          idea_id: job.idea.id,
        })
      }
      if (result.outcome === 'approved' && job.product?.auto_materialize_plan) {
        // Materialize draait ná commit, buiten de idee-lock. Her-check dat de job
        // niet net (na de verdict-commit) geannuleerd/verlopen/her-geclaimd is —
        // anders bouwen we een durabele PBI-boom uit een gestopte review.
        const stillActive = await prisma.claudeJob.findUnique({
          where: { id: job.id },
          select: { status: true, claimed_by_token_id: true },
        })
        if (!reviewStillActive(stillActive, auth.tokenId)) {
          await prisma.ideaLog.create({
            data: {
              idea_id: job.idea.id,
              type: 'JOB_EVENT',
              content: `Auto-materialize overgeslagen: review niet meer actief (${stillActive?.status ?? 'verwijderd'})`,
              metadata: { job_id: job.id },
            },
          })
        } else {
          try {
            await materializeIdeaPlan(prisma, { ideaId: job.idea.id, userId: job.user_id })
            // Hardstop: hierná wordt níets ge-enqueued.
          } catch (err) {
            // Materialize-fout mag de review-afsluiting niet breken: idea blijft
            // PLAN_REVIEWED, de gebruiker kan handmatig materialiseren.
            await prisma.ideaLog.create({
              data: {
                idea_id: job.idea.id,
                type: 'JOB_EVENT',
                content: `Auto-materialize mislukt: ${(err as Error).message}`,
                metadata: { job_id: job.id },
              },
            })
          }
        }
      }
      if (result.outcome === 'rejected') {
        void triggerPush(job.user_id, {
          title: 'Plan afgewezen door review',
          body: summary.slice(0, 120),
          url: '/ideas',
          tag: `idea-review-${job.id}`,
        })
      }

      // Bij een stale (geannuleerde/verlopen) review de summary NIET herstempelen:
      // de job is terminaal en mag geen verdict-samenvatting krijgen.
      if (result.outcome !== 'stale') {
        await prisma.claudeJob.update({
          where: { id: job.id },
          data: { summary: `IDEA_REVIEW_PLAN ${verdict} (${findings.length} findings): ${summary.slice(0, 280)}` },
        })
      }
      return toolJson({ ok: true, verdict, findings_count: findings.length, outcome: result.outcome })
    }

    // ── M23 spec-pipeline: SPEC_REVIEW mét idea = pipeline-verdictpad ────
    if (job.kind === 'SPEC_REVIEW' && job.idea) {
      const result = await applySpecReviewVerdict(
        job as SpecPipelineReviewJob,
        { job_id, verdict, findings, summary },
        auth.tokenId,
      )
      if ((result.outcome === 'plan-started' || result.outcome === 'revision') && result.revisionJobId) {
        await notifyJobEnqueued({
          job_id: result.revisionJobId,
          user_id: job.user_id,
          product_id: job.product_id,
          kind: result.outcome === 'plan-started' ? 'IDEA_MAKE_PLAN' : 'IDEA_REVISE_SPEC',
          idea_id: job.idea.id,
        })
      }
      if (result.outcome === 'rejected') {
        void triggerPush(job.user_id, {
          title: 'Spec afgewezen door review',
          body: summary.slice(0, 120),
          url: '/ideas',
          tag: `idea-spec-review-${job.id}`,
        })
      }
      if (result.outcome !== 'stale') {
        await prisma.claudeJob.update({
          where: { id: job.id },
          data: { summary: `SPEC_REVIEW ${verdict} (${findings.length} findings): ${summary.slice(0, 280)}` },
        })
      }
      return toolJson({ ok: true, verdict, findings_count: findings.length, outcome: result.outcome })
    }

    // ── SPEC_REVIEW (ad-hoc) / TASK_REVIEW (ongewijzigd) ─────────────────
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
        'Persist the verdict of a SPEC_REVIEW/TASK_REVIEW/IDEA_REVIEW_PLAN job into the generic ' +
        'ReviewLog and record a verdict-trace on the job. The job is the ' +
        'authority: kind and target come from the job, never from the input. ' +
        'Idempotent per job. For IDEA_REVIEW_PLAN the verdict drives the M20 ' +
        'plan-review-loop (revision / auto-materialize / escalation). Forbidden for demo accounts.',
      inputSchema,
    },
    handleSubmitReview,
  )
}
