import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    idea: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../../src/prisma.js'
import {
  isManualIdeaKind,
  readManualIdeaInputs,
  loadManualIdeaContext,
} from '../../src/lib/manual-idea-context.js'

const P = prisma as unknown as {
  idea: { findUnique: ReturnType<typeof vi.fn> }
}

beforeEach(() => vi.clearAllMocks())

describe('isManualIdeaKind', () => {
  it('returns true for IDEA_GRILL', () => expect(isManualIdeaKind('IDEA_GRILL')).toBe(true))
  it('returns true for IDEA_MAKE_PLAN', () => expect(isManualIdeaKind('IDEA_MAKE_PLAN')).toBe(true))
  it('returns true for IDEA_REVIEW_PLAN', () => expect(isManualIdeaKind('IDEA_REVIEW_PLAN')).toBe(true))
  it('returns false for PLAN_CHAT', () => expect(isManualIdeaKind('PLAN_CHAT')).toBe(false))
  it('returns false for TASK_IMPLEMENTATION', () =>
    expect(isManualIdeaKind('TASK_IMPLEMENTATION')).toBe(false))
})

describe('readManualIdeaInputs', () => {
  it('reads ideaId and instruction from context', () => {
    const result = readManualIdeaInputs({
      context: { ideaId: 'idea-abc', instruction: 'Focus op UX' },
    })
    expect(result).toEqual({ ideaId: 'idea-abc', instruction: 'Focus op UX' })
  })

  it('returns nulls when context is absent', () => {
    expect(readManualIdeaInputs({})).toEqual({ ideaId: null, instruction: null })
  })

  it('returns nulls when ideaId/instruction are not strings', () => {
    expect(readManualIdeaInputs({ context: { ideaId: 42, instruction: true } })).toEqual({
      ideaId: null,
      instruction: null,
    })
  })

  it('returns null for ideaId when missing, instruction present', () => {
    expect(readManualIdeaInputs({ context: { instruction: 'test' } })).toEqual({
      ideaId: null,
      instruction: 'test',
    })
  })

  it('returns nulls for null input', () => {
    expect(readManualIdeaInputs(null)).toEqual({ ideaId: null, instruction: null })
  })

  it('returns nulls for string input', () => {
    expect(readManualIdeaInputs('not-an-object')).toEqual({ ideaId: null, instruction: null })
  })

  it('returns nulls for array input', () => {
    expect(readManualIdeaInputs(['a', 'b'])).toEqual({ ideaId: null, instruction: null })
  })
})

describe('loadManualIdeaContext', () => {
  it('returns all nulls for non-idea-kind without calling prisma', async () => {
    const result = await loadManualIdeaContext(
      { context: { ideaId: 'idea-x' } },
      'PLAN_CHAT',
    )
    expect(result).toEqual({ idea: null, pbi: null, instruction: null })
    expect(P.idea.findUnique).not.toHaveBeenCalled()
  })

  it('returns idea null (with instruction) when no ideaId in launch_preview for idea-kind', async () => {
    const result = await loadManualIdeaContext(
      { context: { instruction: 'be concise' } },
      'IDEA_GRILL',
    )
    expect(result).toEqual({ idea: null, pbi: null, instruction: 'be concise' })
    expect(P.idea.findUnique).not.toHaveBeenCalled()
  })

  it('loads and maps idea correctly for IDEA_GRILL', async () => {
    const mockIdea = {
      id: 'idea-1',
      code: 'IDEA-42',
      title: 'Cool feature',
      description: 'Does cool stuff',
      status: 'GRILLING',
      product_id: 'prod-1',
      grill_md: 'legacy grill',
      plan_md: 'legacy plan',
      grill_doc: {
        current_revision: { content_md: 'grill from revision' },
      },
      plan_doc: {
        current_revision: { content_md: 'plan from revision' },
      },
      pbi: { id: 'pbi-1', code: 'PBI-10', title: 'Cool PBI' },
    }
    P.idea.findUnique.mockResolvedValueOnce(mockIdea)

    const result = await loadManualIdeaContext(
      { context: { ideaId: 'idea-1', instruction: 'keep it simple' } },
      'IDEA_GRILL',
    )

    expect(P.idea.findUnique).toHaveBeenCalledWith({
      where: { id: 'idea-1' },
      include: {
        pbi: { select: { id: true, code: true, title: true } },
        plan_doc: { select: { current_revision: { select: { content_md: true } } } },
        grill_doc: { select: { current_revision: { select: { content_md: true } } } },
      },
    })

    expect(result.idea).toMatchObject({
      id: 'idea-1',
      code: 'IDEA-42',
      title: 'Cool feature',
      description: 'Does cool stuff',
      status: 'GRILLING',
      product_id: 'prod-1',
      grill_md: 'grill from revision', // from revision, not legacy
      plan_md: 'plan from revision',   // from revision, not legacy
    })
    expect(result.pbi).toEqual({ id: 'pbi-1', code: 'PBI-10', title: 'Cool PBI' })
    expect(result.instruction).toBe('keep it simple')
  })

  it('falls back to legacy grill_md/plan_md when revisions absent', async () => {
    P.idea.findUnique.mockResolvedValueOnce({
      id: 'idea-2',
      code: 'IDEA-2',
      title: 'Idea 2',
      description: 'desc',
      status: 'PLAN_READY',
      product_id: 'prod-2',
      grill_md: 'legacy grill fallback',
      plan_md: 'legacy plan fallback',
      grill_doc: null,
      plan_doc: null,
      pbi: null,
    })

    const result = await loadManualIdeaContext(
      { context: { ideaId: 'idea-2' } },
      'IDEA_MAKE_PLAN',
    )

    expect(result.idea?.grill_md).toBe('legacy grill fallback')
    expect(result.idea?.plan_md).toBe('legacy plan fallback')
    expect(result.pbi).toBeNull()
    expect(result.instruction).toBeNull()
  })

  it('returns idea null when prisma returns null (idea not found)', async () => {
    P.idea.findUnique.mockResolvedValueOnce(null)

    const result = await loadManualIdeaContext(
      { context: { ideaId: 'nonexistent' } },
      'IDEA_GRILL',
    )

    expect(result).toEqual({ idea: null, pbi: null, instruction: null })
  })

  it('returns idea null (best-effort) when prisma throws', async () => {
    P.idea.findUnique.mockRejectedValueOnce(new Error('DB connection failed'))

    const result = await loadManualIdeaContext(
      { context: { ideaId: 'idea-x' } },
      'IDEA_GRILL',
    )

    expect(result).toEqual({ idea: null, pbi: null, instruction: null })
  })

  it('handles malformed launch_preview (null) without throwing', async () => {
    const result = await loadManualIdeaContext(null, 'IDEA_GRILL')
    expect(result).toEqual({ idea: null, pbi: null, instruction: null })
  })

  it('handles malformed launch_preview (string) without throwing', async () => {
    const result = await loadManualIdeaContext('bad', 'IDEA_MAKE_PLAN')
    expect(result).toEqual({ idea: null, pbi: null, instruction: null })
  })

  it('handles malformed launch_preview (array) without throwing', async () => {
    const result = await loadManualIdeaContext(['a', 'b'], 'IDEA_REVIEW_PLAN')
    expect(result).toEqual({ idea: null, pbi: null, instruction: null })
  })
})
