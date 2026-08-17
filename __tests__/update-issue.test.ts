import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    issue: { findUnique: vi.fn() },
  },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  // withToolErrors instanceof-checkt hierop; zonder de export faalt elk
  // foutpad met een mock-resolutiefout in plaats van de echte assertie.
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))
vi.mock('../src/lib/issue-sync.js', () => ({
  syncIssueToForgejo: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleUpdateIssue } from '../src/tools/update-issue.js'
import { toolText } from './helpers/tool-result.js'

const mockTx = prisma.$transaction as ReturnType<typeof vi.fn>
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>
const mockIssueFindUnique = (prisma as unknown as { issue: { findUnique: ReturnType<typeof vi.fn> } }).issue.findUnique

function txDouble() {
  const issueUpdate = vi.fn().mockResolvedValue({ id: 'iss-1', code: 'ISS-3', status: 'INVESTIGATING', resolution: null })
  const issueLogCreate = vi.fn()
  const pbiFindUnique = vi.fn()
  const ideaFindUnique = vi.fn()
  const ideaProductFindUnique = vi.fn()
  return {
    tx: {
      issue: { update: issueUpdate },
      issueLog: { create: issueLogCreate },
      pbi: { findUnique: pbiFindUnique },
      idea: { findUnique: ideaFindUnique },
      ideaProduct: { findUnique: ideaProductFindUnique },
    },
    issueUpdate, issueLogCreate, pbiFindUnique, ideaFindUnique, ideaProductFindUnique,
  }
}

let d: ReturnType<typeof txDouble>

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', username: 'token-user', isDemo: false })
  mockAccess.mockResolvedValue(true)
  mockIssueFindUnique.mockResolvedValue({
    id: 'iss-1', product_id: 'prod-1', status: 'INVESTIGATING', resolution: null,
    research_md: null, resolution_md: null,
  })
  d = txDouble()
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(d.tx))
})

it('weigert een ongeldige transitie CLOSED → PLANNED', async () => {
  mockIssueFindUnique.mockResolvedValue({
    id: 'iss-1', product_id: 'prod-1', status: 'CLOSED', resolution: 'FIXED',
    research_md: null, resolution_md: null,
  })
  const res = await handleUpdateIssue({ issue_id: 'iss-1', status: 'planned' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/niet toegestaan/)
})

it('weigert sluiten zonder resolution', async () => {
  const res = await handleUpdateIssue({ issue_id: 'iss-1', status: 'closed' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/resolution/)
})

it('append bouwt een scheider met timestamp en de opgegeven afzender', async () => {
  await handleUpdateIssue({
    issue_id: 'iss-1', append_research: 'Sweep-log bekeken', authored_by: 'max2:claude',
  })
  const written = d.issueUpdate.mock.calls[0][0].data.research_md as string
  expect(written).toContain('max2:claude')
  expect(written).toContain('Sweep-log bekeken')
  expect(written).toMatch(/\d{4}-\d{2}-\d{2}T/)
})

it('valt zonder authored_by terug op de token-username — nooit op reported_by', async () => {
  mockIssueFindUnique.mockResolvedValue({
    id: 'iss-1', product_id: 'prod-1', status: 'INVESTIGATING', resolution: null,
    research_md: null, resolution_md: null, reported_by: 'max2:melder',
  })
  await handleUpdateIssue({ issue_id: 'iss-1', append_research: 'Onderzoek' })
  const written = d.issueUpdate.mock.calls[0][0].data.research_md as string
  expect(written).toContain('token-user')
  expect(written).not.toContain('max2:melder')
})

it('weigert een lege of te lange authored_by', async () => {
  const blank = await handleUpdateIssue({ issue_id: 'iss-1', append_research: 'X', authored_by: '   ' })
  expect(blank.isError).toBe(true)
  const long = await handleUpdateIssue({ issue_id: 'iss-1', append_research: 'X', authored_by: 'a'.repeat(61) })
  expect(long.isError).toBe(true)
})

it('appendt onder de bestaande tekst in plaats van te overschrijven', async () => {
  mockIssueFindUnique.mockResolvedValue({
    id: 'iss-1', product_id: 'prod-1', status: 'INVESTIGATING', resolution: null,
    research_md: 'Eerdere bevinding', resolution_md: null,
  })
  await handleUpdateIssue({ issue_id: 'iss-1', append_research: 'Nieuwe bevinding' })
  const written = d.issueUpdate.mock.calls[0][0].data.research_md as string
  expect(written).toContain('Eerdere bevinding')
  expect(written).toContain('Nieuwe bevinding')
})

it('weigert een PBI van een ander product', async () => {
  d.pbiFindUnique.mockResolvedValue({ product_id: 'ander-product' })
  const res = await handleUpdateIssue({ issue_id: 'iss-1', link_pbi_id: 'pbi-1' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/hoort niet bij het product/)
})

it('zet dirty + seq in dezelfde transactie als de mutatie', async () => {
  await handleUpdateIssue({ issue_id: 'iss-1', title: 'Nieuwe titel' })
  expect(d.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ forgejo_dirty: true, forgejo_sync_seq: { increment: 1 } }),
  }))
})
