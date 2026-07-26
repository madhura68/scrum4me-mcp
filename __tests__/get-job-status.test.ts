// __tests__/get-job-status.test.ts
import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: { claudeJob: { findUnique: vi.fn() } } }))
vi.mock('../src/auth.js', () => ({ getAuth: vi.fn() }))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { getAuth } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleGetJobStatus } from '../src/tools/get-job-status.js'
import { toolText } from './helpers/tool-result.js'

const mockJob = prisma.claudeJob.findUnique as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  ;(getAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'u1' })
  ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(true)
})

it('geeft status-samenvatting voor een job binnen scope', async () => {
  mockJob.mockResolvedValue({
    id: 'job-1', kind: 'IDEA_GRILL', status: 'RUNNING', product_id: 'p1',
    summary: null, error: null, pr_url: null, created_at: new Date(), finished_at: null,
  })
  const res = await handleGetJobStatus({ job_id: 'job-1' })
  expect(JSON.parse(toolText(res))).toMatchObject({ id: 'job-1', status: 'RUNNING' })
})

it('foreign job → zelfde 404 als onbestaande job (geen oracle)', async () => {
  mockJob.mockResolvedValue({ id: 'job-1', product_id: 'p2', kind: 'PR_REVIEW', status: 'QUEUED' })
  ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(false)
  const res = await handleGetJobStatus({ job_id: 'job-1' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toBe('Job job-1 not found')
  mockJob.mockResolvedValue(null)
  const res2 = await handleGetJobStatus({ job_id: 'job-1' })
  expect(toolText(res2)).toBe('Job job-1 not found')
})
