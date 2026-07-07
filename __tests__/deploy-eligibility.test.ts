import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted voor álle mock-fns (geen buitenliggende const in vi.mock-factories).
// $transaction geeft de gedeelde tx-handle terug.
const txMocks = vi.hoisted(() => ({
  $executeRaw: vi.fn(() => Promise.resolve(0)),
  product: { findUnique: vi.fn() },
  claudeJob: { findFirst: vi.fn() },
}))
const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMocks)),
}))

vi.mock('../src/prisma.js', () => ({ prisma: prismaMocks }))

import { checkDeployEligibility } from '../src/lib/dispatch/deploy-job.js'

beforeEach(() => {
  vi.clearAllMocks()
  txMocks.$executeRaw.mockResolvedValue(0)
  txMocks.product.findUnique.mockResolvedValue({ auto_deploy: true, deploy_flow: 'update_scrum4me_web' })
  txMocks.claudeJob.findFirst.mockResolvedValue(null)
})

describe('checkDeployEligibility', () => {
  it('neemt de product-lock vóór de config-read', async () => {
    await checkDeployEligibility('p1')
    expect(txMocks.$executeRaw).toHaveBeenCalledTimes(1)
    expect(txMocks.$executeRaw.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock')
  })

  it('not_configured bij auto_deploy uit of geen deploy_flow', async () => {
    txMocks.product.findUnique.mockResolvedValue({ auto_deploy: false, deploy_flow: 'x' })
    expect(await checkDeployEligibility('p1')).toBe('not_configured')
    txMocks.product.findUnique.mockResolvedValue({ auto_deploy: true, deploy_flow: null })
    expect(await checkDeployEligibility('p1')).toBe('not_configured')
  })

  it('blocked bij onopgeloste FAILED DEPLOY', async () => {
    txMocks.claudeJob.findFirst.mockResolvedValue({ id: 'failed-1' })
    expect(await checkDeployEligibility('p1')).toBe('blocked')
  })

  it('eligible bij auto_deploy + deploy_flow + geen blokkade', async () => {
    txMocks.product.findUnique.mockResolvedValue({ auto_deploy: true, deploy_flow: 'f' })
    txMocks.claudeJob.findFirst.mockResolvedValue(null)
    expect(await checkDeployEligibility('p1')).toBe('eligible')
  })
})
