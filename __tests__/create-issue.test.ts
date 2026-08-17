import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    product: { findUnique: vi.fn() },
    issue: { findFirst: vi.fn() },
  },
}))
vi.mock('../src/auth.js', () => ({ requireWriteAccess: vi.fn() }))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))
vi.mock('../src/lib/issue-code.js', () => ({
  nextIssueCode: vi.fn().mockResolvedValue('ISS-7'),
}))
vi.mock('../src/lib/issue-sync.js', () => ({
  syncIssueToForgejo: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleCreateIssue } from '../src/tools/create-issue.js'
import { nextIssueCode } from '../src/lib/issue-code.js'
import { toolText } from './helpers/tool-result.js'

const mockTx = prisma.$transaction as ReturnType<typeof vi.fn>
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>
const mockProduct = (prisma as unknown as { product: { findUnique: ReturnType<typeof vi.fn> } }).product.findUnique
const mockIssueFindFirst = (prisma as unknown as { issue: { findFirst: ReturnType<typeof vi.fn> } }).issue.findFirst

/** tx-dubbel dat elke create/update terugmeldt en de logs registreert. */
function txDouble(overrides: { create?: unknown; update?: unknown } = {}) {
  const issueLogCreate = vi.fn()
  const issueCreate = vi.fn().mockResolvedValue(
    overrides.create ?? { id: 'iss-1', code: 'ISS-7', status: 'NEW', occurrence_count: 1 },
  )
  const issueUpdate = vi.fn().mockResolvedValue(
    overrides.update ?? { id: 'iss-1', code: 'ISS-3', status: 'INVESTIGATING', occurrence_count: 2 },
  )
  return {
    tx: { issue: { create: issueCreate, update: issueUpdate }, issueLog: { create: issueLogCreate } },
    issueCreate, issueUpdate, issueLogCreate,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockAccess.mockResolvedValue(true)
  mockProduct.mockResolvedValue({ content_policy: null })
  mockIssueFindFirst.mockResolvedValue(null)
  const d = txDouble()
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(d.tx))
})

it('maakt een nieuw issue zonder fingerprint en genereert de code in de transactie', async () => {
  const res = await handleCreateIssue({ product_id: 'prod-1', title: 'T', description: 'D' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ created: true, issue: { code: 'ISS-7' } })
  expect(nextIssueCode).toHaveBeenCalledWith('prod-1', expect.objectContaining({ issue: expect.anything() }))
})

it('weigert een product buiten toegang/scope (404-stijl)', async () => {
  mockAccess.mockResolvedValue(false)
  const res = await handleCreateIssue({ product_id: 'prod-x', title: 'T', description: 'D' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/not found or not accessible/)
})

it('open fingerprint-hit telt op in plaats van een tweede issue te maken', async () => {
  mockIssueFindFirst.mockResolvedValueOnce({ id: 'iss-open' })
  const d = txDouble()
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(d.tx))

  const res = await handleCreateIssue({
    product_id: 'prod-1', title: 'T', description: 'weer gebeurd', fingerprint: 'max2:mcp:claim-lost',
  })

  expect(JSON.parse(toolText(res))).toMatchObject({ created: false, deduped_into: 'iss-open' })
  expect(d.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 'iss-open' },
    data: expect.objectContaining({
      occurrence_count: { increment: 1 },
      forgejo_dirty: true,
      forgejo_sync_seq: { increment: 1 },
    }),
  }))
  expect(d.issueLogCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ type: 'OCCURRENCE' }),
  }))
  expect(d.issueCreate).not.toHaveBeenCalled()
})

it('gesloten FIXED-hit is een regressie en heropent het issue', async () => {
  mockIssueFindFirst
    .mockResolvedValueOnce(null) // geen open issue
    .mockResolvedValueOnce({ id: 'iss-closed', resolution: 'FIXED' })
  const d = txDouble()
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(d.tx))

  const res = await handleCreateIssue({
    product_id: 'prod-1', title: 'T', description: 'komt terug', fingerprint: 'max2:mcp:claim-lost',
  })

  expect(JSON.parse(toolText(res))).toMatchObject({ created: false, deduped_into: 'iss-closed' })
  expect(d.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ status: 'INVESTIGATING', resolution: null, closed_at: null }),
  }))
  const logTypes = d.issueLogCreate.mock.calls.map((c) => (c[0] as { data: { type: string } }).data.type)
  expect(logTypes).toContain('STATUS_CHANGE')
  expect(logTypes).toContain('REOPENED')
})

it('gesloten WONT_FIX-hit telt alleen op — geen heropening', async () => {
  mockIssueFindFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 'iss-wontfix', resolution: 'WONT_FIX' })
  const d = txDouble({ update: { id: 'iss-wontfix', code: 'ISS-9', status: 'CLOSED', occurrence_count: 4 } })
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(d.tx))

  const res = await handleCreateIssue({
    product_id: 'prod-1', title: 'T', description: 'nog steeds', fingerprint: 'max2:mcp:claim-lost',
  })

  expect(JSON.parse(toolText(res))).toMatchObject({ created: false, issue: { status: 'CLOSED' } })
  expect(d.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.not.objectContaining({ status: expect.anything() }),
  }))
  const logTypes = d.issueLogCreate.mock.calls.map((c) => (c[0] as { data: { type: string } }).data.type)
  expect(logTypes).toEqual(['OCCURRENCE'])
})

it('verliest de insert-race (P2002) en valt terug op het occurrence-pad', async () => {
  const d = txDouble()
  let call = 0
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    call += 1
    if (call === 1) {
      const err = Object.assign(new Error('unique'), { code: 'P2002' })
      Object.setPrototypeOf(err, (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError.prototype)
      throw err
    }
    return fn(d.tx)
  })
  // 1e findFirst: geen open issue; 2e: geen gesloten kandidaat; 3e: de winnaar.
  mockIssueFindFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 'iss-winner' })

  const res = await handleCreateIssue({
    product_id: 'prod-1', title: 'T', description: 'D', fingerprint: 'max2:mcp:claim-lost',
  })

  expect(JSON.parse(toolText(res))).toMatchObject({ created: false, deduped_into: 'iss-winner' })
})

it('weigert inhoud die tegen de product content_policy ingaat (AVG)', async () => {
  mockProduct.mockResolvedValue({
    content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] },
  })
  const res = await handleCreateIssue({ product_id: 'prod-1', title: 'BSN lekt', description: 'bsn in log' })
  expect(res.isError).toBe(true)
})
