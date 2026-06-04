// Helper for loading idea context in MANUAL idea-jobs.
// MANUAL jobs have job.idea_id = null by design (avoids lifecycle cascades);
// the idea is identified via launch_preview_json.context.ideaId instead.

import { prisma } from '../prisma.js'

/** The three idea-oriented job kinds that need idea-context in MANUAL jobs. */
const MANUAL_IDEA_KINDS = new Set(['IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN'])

export function isManualIdeaKind(kind: string): boolean {
  return MANUAL_IDEA_KINDS.has(kind)
}

/** Safely read ideaId and instruction from a launch_preview_json value. */
export function readManualIdeaInputs(launchPreviewJson: unknown): {
  ideaId: string | null
  instruction: string | null
} {
  if (
    launchPreviewJson === null ||
    typeof launchPreviewJson !== 'object' ||
    Array.isArray(launchPreviewJson)
  ) {
    return { ideaId: null, instruction: null }
  }

  const obj = launchPreviewJson as Record<string, unknown>
  const ctx = obj['context']

  if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) {
    return { ideaId: null, instruction: null }
  }

  const ctxObj = ctx as Record<string, unknown>
  const ideaId = typeof ctxObj['ideaId'] === 'string' ? ctxObj['ideaId'] : null
  const instruction =
    typeof ctxObj['instruction'] === 'string' ? ctxObj['instruction'] : null

  return { ideaId, instruction }
}

/** Mapped idea shape matching the SYSTEM idea-branch in wait-for-job.ts. */
export interface MappedIdea {
  id: string
  code: string
  title: string
  description: string | null
  grill_md: string | null
  plan_md: string | null
  status: string
  product_id: string | null
}

/**
 * Load idea context for a MANUAL idea-job.
 *
 * - Non-idea-kinds → `{ idea: null, pbi: null, instruction: null }` (no DB call).
 * - No ideaId in launch_preview → `{ idea: null, pbi: null, instruction }`.
 * - Best-effort: a DB error returns nulls and never throws.
 */
export async function loadManualIdeaContext(
  launchPreviewJson: unknown,
  kind: string,
): Promise<{ idea: MappedIdea | null; pbi: unknown | null; instruction: string | null }> {
  if (!isManualIdeaKind(kind)) {
    return { idea: null, pbi: null, instruction: null }
  }

  const { ideaId, instruction } = readManualIdeaInputs(launchPreviewJson)

  if (!ideaId) {
    return { idea: null, pbi: null, instruction }
  }

  try {
    const raw = await prisma.idea.findUnique({
      where: { id: ideaId },
      include: {
        pbi: { select: { id: true, code: true, title: true } },
        plan_doc: { select: { current_revision: { select: { content_md: true } } } },
        grill_doc: { select: { current_revision: { select: { content_md: true } } } },
      },
    })

    if (!raw) {
      return { idea: null, pbi: null, instruction }
    }

    const idea: MappedIdea = {
      id: raw.id,
      code: raw.code,
      title: raw.title,
      description: raw.description,
      // Revision content wins; fallback to legacy string fields
      grill_md: raw.grill_doc?.current_revision?.content_md ?? raw.grill_md,
      plan_md: raw.plan_doc?.current_revision?.content_md ?? raw.plan_md,
      status: raw.status,
      product_id: raw.product_id,
    }

    return { idea, pbi: raw.pbi ?? null, instruction }
  } catch (err) {
    console.warn('[manual-idea-context] failed to load idea, returning null:', err)
    return { idea: null, pbi: null, instruction }
  }
}
