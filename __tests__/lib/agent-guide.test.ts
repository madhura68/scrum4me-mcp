import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProductDocFolder } from '@prisma/client'

const { mockProductDocFindFirst } = vi.hoisted(() => ({
  mockProductDocFindFirst: vi.fn(),
}))

vi.mock('../../src/prisma.js', () => ({
  prisma: { productDoc: { findFirst: mockProductDocFindFirst } },
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
