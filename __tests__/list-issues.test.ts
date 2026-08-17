import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { issue: { findMany: vi.fn(), findUnique: vi.fn() } },
}))
vi.mock('../src/auth.js', () => ({ getAuth: vi.fn() }))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { getAuth } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleListIssues } from '../src/tools/list-issues.js'
import { handleGetIssue } from '../src/tools/get-issue.js'
import { toolText } from './helpers/tool-result.js'

const mockAuth = getAuth as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>
const mockFindMany = (prisma as unknown as { issue: { findMany: ReturnType<typeof vi.fn> } }).issue.findMany
const mockFindUnique = (prisma as unknown as { issue: { findUnique: ReturnType<typeof vi.fn> } }).issue.findUnique

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', username: 'token-user' })
  mockAccess.mockResolvedValue(true)
  mockFindMany.mockResolvedValue([])
})

it('sluit gesloten issues standaard uit en sorteert op laatst gezien', async () => {
  await handleListIssues({ product_id: 'prod-1' })
  expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ status: { not: 'CLOSED' } }),
    orderBy: { last_seen_at: 'desc' },
    take: 50,
  }))
})

it('neemt gesloten issues mee met include_closed', async () => {
  await handleListIssues({ product_id: 'prod-1', include_closed: true })
  const where = mockFindMany.mock.calls[0][0].where as Record<string, unknown>
  expect(where.status).toBeUndefined()
})

it('geeft status en severity terug in API-lowercase', async () => {
  mockFindMany.mockResolvedValue([{
    id: 'iss-1', code: 'ISS-1', title: 'T', status: 'INVESTIGATING', severity: 'S2_CRITICAL',
    occurrence_count: 3, last_seen_at: new Date('2026-08-16'), fingerprint: 'f', forgejo_number: 12,
  }])
  const res = await handleListIssues({ product_id: 'prod-1' })
  // content.text draagt de rauwe array; het {result}-omhulsel geldt alleen
  // structuredContent (zie toolJson).
  expect(JSON.parse(toolText(res))).toMatchObject([
    { status: 'investigating', severity: 's2_critical' },
  ])
})

it('weigert een product buiten toegang', async () => {
  mockAccess.mockResolvedValue(false)
  const res = await handleListIssues({ product_id: 'prod-x' })
  expect(res.isError).toBe(true)
})

it('get_issue geeft een fout voor een onbekend id', async () => {
  mockFindUnique.mockResolvedValue(null)
  const res = await handleGetIssue({ issue_id: 'onbekend' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/not found or not accessible/)
})
