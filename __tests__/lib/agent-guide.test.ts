import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProductDocFolder } from '@prisma/client'

const { mockProductDocFindFirst, mockAgentModelFindUnique } = vi.hoisted(() => ({
  mockProductDocFindFirst: vi.fn(),
  mockAgentModelFindUnique: vi.fn(),
}))

vi.mock('../../src/prisma.js', () => ({
  prisma: { productDoc: { findFirst: mockProductDocFindFirst }, agentModel: { findUnique: mockAgentModelFindUnique } },
}))

import {
  resolveAgentGuide,
  AGENT_GUIDE_MAX_CHARS,
  AgentGuideTooLargeError,
} from '../../src/lib/agent-guide.js'
import { AGENT_GUIDE_DEFAULT } from '../../src/lib/agent-guide-default.js'

const productWithManual = {
  id: 'p1',
  code: 'P1',
  name: 'Test product',
  enabled_doc_folders: [ProductDocFolder.MANUAL],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProductDocFindFirst.mockResolvedValue(null)
  mockAgentModelFindUnique.mockReset().mockResolvedValue(null)
})

describe('runtime and exact-model guide selection', () => {
  const doc = (slug: string, body: string) => ({ slug, status: 'active', content_md: body, updated_at: new Date('2026-09-23') })
  const resolve = async (agent?: { runtime: string; model_id?: string }) =>
    JSON.parse(JSON.stringify(await Reflect.apply(resolveAgentGuide, undefined, [productWithManual, agent])))

  beforeEach(() => {
    mockAgentModelFindUnique.mockImplementation(async ({ where }) => {
      const key = where.runtime_model_id
      if (key.runtime === 'CODEX' && key.model_id === 'gpt-6-astra') return { id: 'astra', display_name: 'GPT-6 Astra' }
      if (key.runtime === 'CODEX' && key.model_id === 'gpt-5.6-sol') return { id: 'sol', display_name: 'GPT-5.6 Sol' }
      if (key.runtime === 'CLAUDE' && key.model_id === 'claude-opus-5') return { id: 'opus', display_name: 'Opus 5' }
      return null
    })
    const docs: Record<string, ReturnType<typeof doc>> = {
      'agent-guide': doc('agent-guide', 'PRODUCT RULES'),
      'agent-guide-runtime-codex': doc('agent-guide-runtime-codex', 'CODEX RUNTIME'),
      'agent-guide-runtime-claude': doc('agent-guide-runtime-claude', 'CLAUDE RUNTIME'),
      'agent-guide-model-astra': doc('agent-guide-model-astra', 'ASTRA PROFILE'),
      'agent-guide-model-sol': doc('agent-guide-model-sol', 'SOL PROFILE'),
      'agent-guide-model-opus': doc('agent-guide-model-opus', 'OPUS PROFILE'),
    }
    mockProductDocFindFirst.mockImplementation(async ({ where }) => {
      expect(where).toMatchObject({ product_id: 'p1', folder: 'MANUAL', status: 'active' })
      return docs[where.slug] ?? null
    })
  })

  it('composes default, runtime, exact model and product rules in that order', async () => {
    const result = await resolve({ runtime: 'CODEX', model_id: 'gpt-6-astra' })
    const text = result.guide_md as string
    expect(text.startsWith(AGENT_GUIDE_DEFAULT)).toBe(true)
    expect(text).toContain('CODEX RUNTIME')
    expect(text).toContain('ASTRA PROFILE')
    expect(text.indexOf('CODEX RUNTIME')).toBeLessThan(text.indexOf('ASTRA PROFILE'))
    expect(text.indexOf('ASTRA PROFILE')).toBeLessThan(text.indexOf('PRODUCT RULES'))
    expect(text).not.toMatch(/SOL PROFILE|OPUS PROFILE|CLAUDE RUNTIME/)
    expect(result.agent_context).toEqual({ runtime: 'CODEX', model_id: 'gpt-6-astra', display_name: 'GPT-6 Astra', applied_profiles: ['agent-guide-runtime-codex', 'agent-guide-model-astra', 'agent-guide'] })
    expect(mockAgentModelFindUnique).toHaveBeenCalledWith({ where: { runtime_model_id: { runtime: 'CODEX', model_id: 'gpt-6-astra' } }, select: { id: true, display_name: true } })
  })

  it('keeps sequential model/runtime calls isolated', async () => {
    await resolve({ runtime: 'CODEX', model_id: 'gpt-6-astra' })
    const sol = await resolve({ runtime: 'CODEX', model_id: 'gpt-5.6-sol' })
    const opus = await resolve({ runtime: 'CLAUDE', model_id: 'claude-opus-5' })
    const neutral = await resolve()
    expect(sol.guide_md).toContain('SOL PROFILE')
    expect(sol.guide_md).not.toContain('ASTRA PROFILE')
    expect(opus.guide_md).toContain('OPUS PROFILE')
    expect(opus.guide_md).not.toContain('CODEX RUNTIME')
    expect(neutral.guide_md).not.toMatch(/RUNTIME|PROFILE/)
    expect(neutral.agent_context).toEqual({ runtime: null, model_id: null, display_name: null, applied_profiles: ['agent-guide'] })
  })

  it('keeps unknown model IDs and applies only available general layers', async () => {
    const result = await resolve({ runtime: 'CODEX', model_id: 'future.unknown' })
    expect(result.agent_context).toEqual({ runtime: 'CODEX', model_id: 'future.unknown', display_name: null, applied_profiles: ['agent-guide-runtime-codex', 'agent-guide'] })
    expect(result.guide_md).not.toContain('PROFILE')
  })

  it('allows runtime-only input and does not look up a default model', async () => {
    const result = await resolve({ runtime: 'CLAUDE' })
    expect(result.guide_md).toContain('CLAUDE RUNTIME')
    expect(mockAgentModelFindUnique).not.toHaveBeenCalled()
    expect(result.agent_context.model_id).toBeNull()
  })

  it('uses only the remaining profiles when a runtime/model doc is unavailable', async () => {
    mockProductDocFindFirst.mockImplementation(async ({ where }) => where.slug === 'agent-guide' ? doc('agent-guide', 'ONLY PRODUCT') : null)
    const result = await resolve({ runtime: 'CODEX', model_id: 'gpt-6-astra' })
    expect(result.agent_context.applied_profiles).toEqual(['agent-guide'])
    expect(result.guide_md).toContain('ONLY PRODUCT')
  })

  it('does not load any profiles when MANUAL is disabled', async () => {
    const result = await Reflect.apply(resolveAgentGuide, undefined, [{ ...productWithManual, enabled_doc_folders: [] }, { runtime: 'CODEX', model_id: 'gpt-6-astra' }])
    expect(result.guide_md).toBe(AGENT_GUIDE_DEFAULT)
    expect(mockProductDocFindFirst).not.toHaveBeenCalled()
  })

  it('caps the combined guide, including supplemental profiles', async () => {
    mockProductDocFindFirst.mockImplementation(async ({ where }) => where.slug === 'agent-guide-model-astra' ? doc(where.slug, 'x'.repeat(AGENT_GUIDE_MAX_CHARS)) : null)
    await expect(resolve({ runtime: 'CODEX', model_id: 'gpt-6-astra' })).rejects.toBeInstanceOf(AgentGuideTooLargeError)
  })
})

describe('resolveAgentGuide', () => {
  it('returns only the global default when there is no override', async () => {
    const result = await resolveAgentGuide(productWithManual)
    expect(result.guide_md).toBe(AGENT_GUIDE_DEFAULT)
    expect(result.has_product_override).toBe(false)
    expect(result.product_doc).toBeNull()
  })

  it('queries only active MANUAL/agent-guide docs', async () => {
    await resolveAgentGuide(productWithManual)
    expect(mockProductDocFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          product_id: 'p1',
          folder: ProductDocFolder.MANUAL,
          slug: 'agent-guide',
          status: 'active',
        },
      }),
    )
  })

  it('skips the override query when MANUAL folder is disabled', async () => {
    await resolveAgentGuide({ ...productWithManual, enabled_doc_folders: [] })
    expect(mockProductDocFindFirst).not.toHaveBeenCalled()
  })

  it('appends an active override as a labeled section', async () => {
    mockProductDocFindFirst.mockResolvedValue({
      slug: 'agent-guide',
      status: 'active',
      content_md: 'Always run the linter.',
      updated_at: new Date('2026-05-23T00:00:00Z'),
    })
    const result = await resolveAgentGuide(productWithManual)
    expect(result.guide_md.startsWith(AGENT_GUIDE_DEFAULT)).toBe(true)
    expect(result.guide_md).toContain('## Product-specifieke aanvullingen — P1')
    expect(result.guide_md).toContain('Always run the linter.')
    expect(result.has_product_override).toBe(true)
    expect(result.product_doc).toEqual({
      slug: 'agent-guide',
      status: 'active',
      updated_at: new Date('2026-05-23T00:00:00Z'),
    })
  })

  it('appends only the ProductDoc body, not YAML frontmatter', async () => {
    mockProductDocFindFirst.mockResolvedValue({
      slug: 'agent-guide',
      status: 'active',
      content_md: [
        '---',
        'title: Agent guide',
        'status: active',
        '---',
        '',
        'Always run the product smoke test.',
      ].join('\n'),
      updated_at: new Date('2026-05-24T00:00:00Z'),
    })

    const result = await resolveAgentGuide(productWithManual)

    expect(result.guide_md).toContain('Always run the product smoke test.')
    expect(result.guide_md).not.toContain('title: Agent guide')
    expect(result.guide_md).not.toContain('status: active')
  })

  it('throws AgentGuideTooLargeError when the merged guide exceeds the cap', async () => {
    mockProductDocFindFirst.mockResolvedValue({
      slug: 'agent-guide',
      status: 'active',
      content_md: 'x'.repeat(AGENT_GUIDE_MAX_CHARS + 1),
      updated_at: new Date(),
    })
    await expect(resolveAgentGuide(productWithManual)).rejects.toBeInstanceOf(
      AgentGuideTooLargeError,
    )
  })
})
