// MCP-tool (M23): schrijft het specificatie-document van de spec-fase als
// ProductDoc(SPECS) + immutable revisie, zet Idea.spec_doc_id, en dispatcht
// post-commit de SPEC_REVIEW-review-job (pipeline-keten). Geen parse-gate:
// de spec is proza, geen YAML-contract.
//
// Wordt aangeroepen door de worker als laatste stap van een
// IDEA_MAKE_SPEC/IDEA_REVISE_SPEC-sessie.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userOwnsIdea } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import {
  writeProductDoc,
  ProductDocWriteError,
} from '../lib/product-doc-write.js'
import { ensureProductDocFrontmatter } from '../lib/ensure-product-doc-frontmatter.js'
import { REVIEW_JOB_FIELDS } from '../lib/dispatch/review-jobs.js'
import { notifyJobEnqueued } from '../lib/dispatch/notify.js'
import {
  findActiveSpecLoopJob,
  lockIdeaRow,
  specLoopKey,
  parseLoopRound,
  isP2002,
} from '../lib/idea-plan-loop.js'

export const inputSchema = z.object({
  idea_id: z.string().min(1),
  markdown: z.string().min(1).max(64_000),
})

// M23 auto-dispatch: ná een geslaagde spec-write enqueuet dit de SPEC_REVIEW
// van deze ronde. Pipeline-semantiek: review volgt altijd (geen toggle).
// Ronde n = ronde van de triggerende maker-job (button-job zonder key = r1).
// Idempotent via de composiet-unique (created_by_job_id, orchestration_key).
async function maybeAutoDispatchSpecReview(ideaId: string, revisionId: string): Promise<void> {
  const makerJob = await prisma.claudeJob.findFirst({
    where: {
      idea_id: ideaId,
      kind: { in: ['IDEA_MAKE_SPEC', 'IDEA_REVISE_SPEC'] },
      status: { in: ['CLAIMED', 'RUNNING'] },
    },
    orderBy: { created_at: 'desc' },
    select: { id: true, orchestration_key: true, user_id: true, product_id: true },
  })
  if (!makerJob) return // geen actieve maker → geen keten (spec-writes zijn job-gedreven)

  const idea = await prisma.idea.findUnique({
    where: { id: ideaId },
    select: { spec_doc_id: true },
  })
  if (!idea?.spec_doc_id) return

  const round = parseLoopRound(makerJob.orchestration_key) || 1

  let reviewJobId: string | null = null
  try {
    reviewJobId = await prisma.$transaction(async (tx) => {
      await lockIdeaRow(tx, ideaId)
      const active = await findActiveSpecLoopJob(tx, ideaId, makerJob.id)
      if (active) return null // andere spec-loop-job actief → geen dubbele keten
      const j = await tx.claudeJob.create({
        data: {
          user_id: makerJob.user_id,
          product_id: makerJob.product_id,
          idea_id: ideaId,
          kind: 'SPEC_REVIEW',
          doc_id: idea.spec_doc_id,
          doc_revision_id: revisionId, // M23: revisie-pin op dispatch-moment
          // LET OP volgorde (server-r2 N7): REVIEW_JOB_FIELDS bevat
          // source:'COPILOT'; de SYSTEM-override moet NÁ de spread — een
          // COPILOT-SPEC_REVIEW mét idea_id schendt de CHECK-constraint (23514).
          ...REVIEW_JOB_FIELDS,
          source: 'SYSTEM',
          created_by_job_id: makerJob.id,
          orchestration_key: specLoopKey(ideaId, round),
          summary: `Auto spec-review r${round}`,
        },
        select: { id: true },
      })
      await tx.idea.update({ where: { id: ideaId }, data: { status: 'SPEC_REVIEWING' } })
      await tx.ideaLog.create({
        data: {
          idea_id: ideaId,
          type: 'JOB_EVENT',
          content: `SPEC_REVIEW queued (spec r${round})`,
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
      user_id: makerJob.user_id,
      product_id: makerJob.product_id,
      kind: 'SPEC_REVIEW',
      idea_id: ideaId,
    })
  }
}

export async function handleUpdateIdeaSpecMd(input: { idea_id: string; markdown: string }) {
  const { idea_id, markdown } = input
  const auth = await requireWriteAccess()
  if (!(await userOwnsIdea(idea_id, auth.userId))) {
    return toolError('Idea not found')
  }

  const idea = await prisma.idea.findUnique({
    where: { id: idea_id },
    select: {
      id: true,
      code: true,
      user_id: true,
      product_id: true,
      title: true,
    },
  })
  if (!idea?.product_id) {
    return toolError('Idea has no product_id — assign product before SPEC')
  }

  const content = ensureProductDocFrontmatter(markdown, idea.title)
  const slug = `${idea.code.toLowerCase()}-spec`

  try {
    const result = await prisma.$transaction(async (tx) => {
      const wr = await writeProductDoc(tx, {
        product_id: idea.product_id!,
        folder: 'SPECS',
        slug,
        content_md: content,
        actor_user_id: idea.user_id,
      })
      const updatedIdea = await tx.idea.update({
        where: { id: idea_id },
        data: { spec_doc_id: wr.doc_id },
        select: { id: true, status: true, code: true },
      })
      await tx.ideaLog.create({
        data: {
          idea_id,
          type: 'PLAN_RESULT',
          content: `Spec saved as ProductDoc ${slug} (rev ${wr.revision})`,
          metadata: {
            doc_id: wr.doc_id,
            revision_id: wr.revision_id,
            revision: wr.revision,
            noop: wr.noop,
          },
        },
      })
      return { idea: updatedIdea, wr }
    })

    // M23: keten-side-effect ná commit — faalt best-effort niet-fataal
    // (de spec-write is al gecommit; een dispatch-fout mag de respons niet breken).
    try {
      await maybeAutoDispatchSpecReview(idea_id, result.wr.revision_id)
    } catch (err) {
      console.error('maybeAutoDispatchSpecReview failed (spec is al opgeslagen):', err)
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
      return toolError(`Cannot save spec as ProductDoc: ${err.message}`)
    }
    throw err
  }
}

export function registerUpdateIdeaSpecMdTool(server: McpServer) {
  server.registerTool(
    'update_idea_spec_md',
    {
      title: 'Update idea spec (SPECS-doc)',
      description:
        'Save the spec-phase markdown for an idea (M23 pipeline): writes a ProductDoc (folder=SPECS, slug {code}-spec) + immutable revision, sets Idea.spec_doc_id, and auto-dispatches the SPEC_REVIEW job for this round (pins the written revision via doc_revision_id; flips status to SPEC_REVIEWING). No YAML contract — the spec is prose. Requires Idea.product_id. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ idea_id, markdown }) => withToolErrors(() => handleUpdateIdeaSpecMd({ idea_id, markdown })),
  )
}
