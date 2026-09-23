import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureContextTools } from '../helpers/capture-context-tools.js'

const findIdeas = vi.hoisted(() => vi.fn())
const access = vi.hoisted(() => vi.fn())
vi.mock('../../src/prisma.js', () => ({ prisma: { idea: { findMany: findIdeas } } }))
vi.mock('../../src/auth.js', () => ({ getAuth: async () => ({ userId: 'u1' }), PermissionDeniedError: class extends Error {} }))
vi.mock('../../src/access.js', () => ({ userCanAccessProduct: access }))
import { registerSharedTools } from '../../src/register.js'

beforeEach(() => { vi.resetAllMocks(); access.mockResolvedValue(true); findIdeas.mockResolvedValue([]) })

describe('get_ideas_context', () => {
  it('preserves the original own/open/product-or-unassigned selection, oldest first and max 50', async () => {
    findIdeas.mockResolvedValue([{ id: 'i1', code: 'IDEA-1', title: 'Idea', status: 'DRAFT', created_at: '2026-01-01' }])
    const data = await captureContextTools(registerSharedTools).json('get_ideas_context', { product_id: 'p1' })
    expect(data).toEqual({ product_id: 'p1', limit: 50, open_ideas: [{ id: 'i1', code: 'IDEA-1', title: 'Idea', status: 'DRAFT', created_at: '2026-01-01' }] })
    expect(findIdeas).toHaveBeenCalledWith({
      where: { user_id: 'u1', archived: false, status: { not: 'PLANNED' }, OR: [{ product_id: 'p1' }, { product_id: null }] },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 50,
      select: { id: true, code: true, title: true, status: true, created_at: true },
    })
  })
  it('refuses an inaccessible product before reading any ideas', async () => {
    access.mockResolvedValue(false)
    const result = await captureContextTools(registerSharedTools).call('get_ideas_context', { product_id: 'p1' })
    expect(result.isError).toBe(true)
    expect(findIdeas).not.toHaveBeenCalled()
  })
})
