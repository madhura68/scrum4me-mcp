import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    jobKindConfig: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { getJobConfigSnapshot } from '../src/lib/dispatch/snapshot.js'

const mockProduct = prisma.product.findUnique as ReturnType<typeof vi.fn>
const mockTask = prisma.task.findUnique as ReturnType<typeof vi.fn>
const mockKind = prisma.jobKindConfig.findUnique as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockProduct.mockReset()
  mockTask.mockReset()
  mockKind.mockReset()
  mockProduct.mockResolvedValue(null)
})

describe('getJobConfigSnapshot — DB-aware (M39 B6, heft §1.2-shadowing op)', () => {
  it('volgt de JobKindConfig-rij i.p.v. de code-KIND_DEFAULTS', async () => {
    mockKind.mockResolvedValue({
      claude_model: 'claude-sonnet-5',
      thinking_budget: 12345,
      claude_permission_mode: 'acceptEdits',
    })
    const snap = await getJobConfigSnapshot({ kind: 'IDEA_MAKE_SPEC', productId: 'p1' })
    expect(snap.requested_model).toBe('claude-sonnet-5')
    expect(snap.requested_thinking_budget).toBe(12345)
    expect(snap.requested_permission_mode).toBe('acceptEdits')
  })

  it('valt terug op KIND_DEFAULTS wanneer er geen JobKindConfig-rij is', async () => {
    mockKind.mockResolvedValue(null)
    const snap = await getJobConfigSnapshot({ kind: 'IDEA_MAKE_SPEC', productId: 'p1' })
    expect(snap.requested_model).toBe('claude-opus-5')
    expect(snap.requested_thinking_budget).toBe(24000)
  })
})
