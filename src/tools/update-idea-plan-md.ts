// MCP-tool: schrijft het plan_md-resultaat na een IDEA_MAKE_PLAN-job en
// transitioneert de idea-status naar PLAN_READY (bij geldige yaml-frontmatter)
// of PLAN_FAILED (bij parse-fout).
//
// Wordt aangeroepen door de worker als laatste stap van een make-plan-sessie.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userOwnsIdea } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { parsePlanMd } from '../lib/idea-plan-parser.js'
import {
  writeProductDoc,
  ProductDocWriteError,
} from '../lib/product-doc-write.js'
import { ensureProductDocFrontmatter } from '../lib/ensure-product-doc-frontmatter.js'
import { REVIEW_JOB_FIELDS } from '../lib/dispatch/review-jobs.js'
import { notifyJobEnqueued } from '../lib/dispatch/notify.js'
import { findActiveLoopJob, lockIdeaRow, loopKey, parseLoopRound, isP2002 } from '../lib/idea-plan-loop.js'

// Backwards-compat re-export: this helper used to live here. Keep the path
// stable for existing importers (e.g. update-idea-plan-frontmatter.test.ts).
export { ensureProductDocFrontmatter }

export const inputSchema = z.object({
  idea_id: z.string().min(1),
  markdown: z.string().min(1).max(64_000),
})

// M20 auto-dispatch: na een geslaagde plan-write (PLAN_READY) en met
// product.auto_plan_review aan, enqueuet dit een IDEA_REVIEW_PLAN-review-job
// die de codex-worker claimt. Ronde n = ronde van de triggerende
// IDEA_MAKE_PLAN-job (plan r{n} ↔ review r{n}; button-job zonder key = ronde 1).
// Idempotent via de composiet-unique (created_by_job_id, orchestration_key).
async function maybeAutoDispatchPlanReview(
  ideaId: string,
  autoPlanReview: boolean,
  // M23: pin — het zojuist geschreven plan-doc + de exacte revisie die de
  // reviewer moet beoordelen (doorgegeven aan ReviewLog bij verdict).
  pin?: { docId: string; revisionId: string },
): Promise<void> {
  if (!autoPlanReview) return

  const makePlanJob = await prisma.claudeJob.findFirst({
    where: { idea_id: ideaId, kind: 'IDEA_MAKE_PLAN', status: { in: ['CLAIMED', 'RUNNING'] } },
    orderBy: { created_at: 'desc' },
    select: { id: true, orchestration_key: true, user_id: true, product_id: true },
  })
  if (!makePlanJob) return // handmatige plan-edit zonder actieve job → geen loop

  const round = parseLoopRound(makePlanJob.orchestration_key) || 1

  let reviewJobId: string | null = null
  try {
    reviewJobId = await prisma.$transaction(async (tx) => {
      await lockIdeaRow(tx, ideaId)
      const active = await findActiveLoopJob(tx, ideaId, makePlanJob.id)
      if (active) return null // andere loop-job actief → geen dubbele keten
      const j = await tx.claudeJob.create({
        data: {
          user_id: makePlanJob.user_id,
          product_id: makePlanJob.product_id,
          idea_id: ideaId,
          kind: 'IDEA_REVIEW_PLAN',
          ...(pin ? { doc_id: pin.docId, doc_revision_id: pin.revisionId } : {}),
          ...REVIEW_JOB_FIELDS,
          source: 'SYSTEM', // systeem-geïnitieerd (override COPILOT uit REVIEW_JOB_FIELDS)
          created_by_job_id: makePlanJob.id,
          orchestration_key: loopKey(ideaId, round),
          summary: `Auto plan-review r${round}`,
        },
        select: { id: true },
      })
      await tx.idea.update({ where: { id: ideaId }, data: { status: 'REVIEWING_PLAN' } })
      await tx.ideaLog.create({
        data: {
          idea_id: ideaId,
          type: 'JOB_EVENT',
          content: `IDEA_REVIEW_PLAN queued (review r${round})`,
          metadata: { job_id: j.id, round },
        },
      })
      return j.id
    })
  } catch (err) {
    if (!isP2002(err)) throw err
    // dedup: ronde al gedispatcht (tool-retry) → no-op
  }

  if (reviewJobId) {
    await notifyJobEnqueued({
      job_id: reviewJobId,
      user_id: makePlanJob.user_id,
      product_id: makePlanJob.product_id,
      kind: 'IDEA_REVIEW_PLAN',
      idea_id: ideaId,
    })
  }
}

export async function handleUpdateIdeaPlanMd(input: { idea_id: string; markdown: string }) {
  const { idea_id, markdown } = input
  const auth = await requireWriteAccess()
  if (!(await userOwnsIdea(idea_id, auth.userId))) {
    return toolError('Idea not found')
  }

  const parsed = parsePlanMd(markdown)

  if (!parsed.ok) {
    // Plan-yaml parse failed → behoud bestaande dual-write naar
    // Idea.plan_md, status PLAN_FAILED, GEEN ProductDoc-write
    // (de content is corrupt; eerst fixen).
    const result = await prisma.$transaction([
      prisma.idea.update({
        where: { id: idea_id },
        data: { plan_md: markdown, status: 'PLAN_FAILED' },
        select: { id: true, status: true, code: true },
      }),
      prisma.ideaLog.create({
        data: {
          idea_id,
          type: 'JOB_EVENT',
          content: 'plan_md parse failed',
          metadata: { errors: parsed.errors },
        },
      }),
    ])
    return toolJson({
      ok: false,
      idea: result[0],
      errors: parsed.errors,
    })
  }

  const idea = await prisma.idea.findUnique({
    where: { id: idea_id },
    select: {
      id: true,
      code: true,
      user_id: true,
      product_id: true,
      title: true,
      product: { select: { auto_plan_review: true } },
    },
  })
  if (!idea?.product_id) {
    return toolError('Idea has no product_id — assign product before PLAN')
  }

  const content = ensureProductDocFrontmatter(markdown, idea.title)
  const slug = `${idea.code.toLowerCase()}-plan`
  const storyCount = parsed.plan.stories.length
  const taskCount = parsed.plan.stories.reduce((n, s) => n + s.tasks.length, 0)

  try {
    const result = await prisma.$transaction(async (tx) => {
      const wr = await writeProductDoc(tx, {
        product_id: idea.product_id!,
        folder: 'PLANS',
        slug,
        content_md: content,
        actor_user_id: idea.user_id,
      })
      const updatedIdea = await tx.idea.update({
        where: { id: idea_id },
        data: {
          plan_md: markdown, // dual-write voor wait-for-job compat
          plan_doc_id: wr.doc_id,
          status: 'PLAN_READY',
        },
        select: { id: true, status: true, code: true },
      })
      await tx.ideaLog.create({
        data: {
          idea_id,
          type: 'PLAN_RESULT',
          content: `Plan ready: ${storyCount} stories, ${taskCount} tasks (rev ${wr.revision})`,
          metadata: {
            pbi_title: parsed.plan.pbi.title,
            story_count: storyCount,
            task_count: taskCount,
            doc_id: wr.doc_id,
            revision_id: wr.revision_id,
            revision: wr.revision,
            noop: wr.noop,
          },
        },
      })
      return { idea: updatedIdea, wr }
    })

    // M20: keten-side-effect ná commit van de plan-write. Faalt best-effort
    // niet-fataal (de plan-write is al gecommit; een dispatch-fout mag de
    // tool-respons niet breken).
    try {
      await maybeAutoDispatchPlanReview(idea_id, idea.product?.auto_plan_review ?? false, { docId: result.wr.doc_id, revisionId: result.wr.revision_id })
    } catch (err) {
      console.error('maybeAutoDispatchPlanReview failed (plan is al PLAN_READY):', err)
    }

    return toolJson({
      ok: true,
      idea: result.idea,
      doc: {
        id: result.wr.doc_id,
        revision_id: result.wr.revision_id,
        revision: result.wr.revision,
      },
    })
  } catch (err) {
    if (err instanceof ProductDocWriteError) {
      // err.message now carries the precise parse detail (zie product-doc-write).
      return toolError(`Cannot save plan as ProductDoc: ${err.message}`)
    }
    throw err
  }
}

export function registerUpdateIdeaPlanMdTool(server: McpServer) {
  server.registerTool(
    'update_idea_plan_md',
    {
      title: 'Update idea plan_md',
      description:
        'Save the make-plan-result markdown for an idea: validates plan-yaml first; on success writes a ProductDoc (folder=PLANS) + immutable revision, sets Idea.plan_doc_id, dual-writes Idea.plan_md for backward-compat, and transitions status to PLAN_READY. On plan-parse-fail status → PLAN_FAILED (no ProductDoc-write). With product.auto_plan_review it also enqueues an IDEA_REVIEW_PLAN codex-review (M20 plan-review-loop). Requires Idea.product_id. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ idea_id, markdown }) => withToolErrors(() => handleUpdateIdeaPlanMd({ idea_id, markdown })),
  )
}
