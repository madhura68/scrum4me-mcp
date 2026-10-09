import { beforeEach, describe, expect, it, vi } from 'vitest'

// M45-3 (test g): de jobrij van update_job_status moet `runtime` en `required_capability` selecteren, want dezelfde
// rij gaat naar isHarnessJobRow(job) bij de drie permanente bewakingen (geen auto-PR, geen doorwerking, geen
// PBI-faalcascade). Een mock die altijd een volledige fixture teruggeeft, zou een ontbrekend veld verbergen; daarom
// controleert deze test de `select` van de aanroep zelf. isHarnessJob doet een findUnique met dezelfde vorm
// (`{ runtime, required_capability }`), dus de test kiest de jobrij-aanroep aan een veld dat alleen die heeft.

const authMocks = vi.hoisted(() => ({ requireWriteAccess: vi.fn() }))
vi.mock('../src/auth.js', () => authMocks)
vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return { connect: vi.fn(), query: vi.fn(), end: vi.fn() }
  }),
}))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
    product: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { registerUpdateJobStatusTool } from '../src/tools/update-job-status.js'

const findUnique = (prisma as unknown as { claudeJob: { findUnique: ReturnType<typeof vi.fn> } }).claudeJob.findUnique

function registerHandler() {
  let handler: ((input: { job_id: string; status: 'done'; summary?: string }) => Promise<unknown>) | null = null
  registerUpdateJobStatusTool({
    registerTool: (_n: string, _c: unknown, cb: typeof handler) => {
      handler = cb
    },
  } as never)
  return handler!
}

describe('update_job_status: de jobrij selecteert de velden van de bewaking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMocks.requireWriteAccess.mockResolvedValue({ tokenId: 'token-1', userId: 'user-1' })
    // Een onbekende job: de handler stopt direct na de jobrij, dus de select van die aanroep is wat telt.
    findUnique.mockResolvedValue(null)
  })

  it('vraagt runtime en required_capability op in de select van de jobrij', async () => {
    await registerHandler()({ job_id: 'job-1', status: 'done', summary: 'klaar' })

    const jobRowCalls = findUnique.mock.calls.filter(
      ([args]) => (args as { select?: Record<string, unknown> }).select?.chat_cutoff_message_id === true,
    )
    expect(jobRowCalls).toHaveLength(1)
    const select = (jobRowCalls[0][0] as { select: Record<string, unknown> }).select
    expect(select.runtime).toBe(true)
    expect(select.required_capability).toBe(true)
  })
})
