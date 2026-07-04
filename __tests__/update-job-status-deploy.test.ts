// Unit-tests voor de DEPLOY-lifecycle-branch in update_job_status (M17 spec §3/§6).
// Volle handler-integratie hangt aan tientallen MCP/Prisma-mocks (zie
// update-job-status-skipped.test.ts) — hier testen we de geëxporteerde pure
// helpers: checkDeploySkipReason (skipped-verruiming) en
// applyDeployTerminalUpdate (atomaire terminale transitie: lock →
// terminale update → bulk-cancel bij failed / resolved_at-lift bij done).

import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('checkDeploySkipReason (spec §3: verplichte skipped-redenen)', () => {
  it('accepteert doc_only_merge en merge_sha_already_deployed', async () => {
    const { checkDeploySkipReason } = await import('../src/tools/update-job-status.js')
    expect(checkDeploySkipReason('doc_only_merge').allowed).toBe(true)
    expect(checkDeploySkipReason('merge_sha_already_deployed: 77199ba al live').allowed).toBe(true)
  })

  it('weigert vrije tekst en lege redenen', async () => {
    const { checkDeploySkipReason } = await import('../src/tools/update-job-status.js')
    expect(checkDeploySkipReason('geen zin').allowed).toBe(false)
    expect(checkDeploySkipReason(undefined).allowed).toBe(false)
  })
})

// applyDeployTerminalUpdate praat rechtstreeks met prisma.$transaction — mock
// hem hier los van de rest van de module (die zelf ../src/prisma.js gebruikt).
vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { applyDeployTerminalUpdate } from '../src/tools/update-job-status.js'

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
}

describe('applyDeployTerminalUpdate (spec §3/§6: lock + terminale update + bulk-cancel/lift in 1 tx)', () => {
  // Gedeeld callOrder-array (zelfde patroon als de web-test
  // __tests__/actions/deploy.test.ts): élke tx-operatie pusht zijn naam zodat
  // de asserts de vólgorde afdwingen — niet alleen dát calls plaatsvonden.
  // (Review-mutatie bewees dat losse per-mock-arrays met lengte-asserts de
  // lock-vóór-update-volgorde niet vingen.)
  let callOrder: string[]
  let updateManyCalls: unknown[]
  let findManyResult: Array<{ id: string }>

  beforeEach(() => {
    vi.clearAllMocks()
    callOrder = []
    updateManyCalls = []
    findManyResult = []

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: vi.fn(() => {
          callOrder.push('lock')
          return Promise.resolve(0)
        }),
        claudeJob: {
          update: vi.fn(() => {
            callOrder.push('update')
            return Promise.resolve({
              id: 'job-1',
              status: 'DONE',
              summary: 'ok',
              error: null,
              pr_url: null,
            })
          }),
          findMany: vi.fn(() => {
            callOrder.push('findMany')
            return Promise.resolve(findManyResult)
          }),
          updateMany: vi.fn((args: unknown) => {
            callOrder.push('updateMany')
            updateManyCalls.push(args)
            return Promise.resolve({ count: findManyResult.length })
          }),
        },
      }),
    )
  })

  it('neemt de product-lock vóór de terminale update (done: lock → update → lift)', async () => {
    await applyDeployTerminalUpdate({
      jobId: 'job-1',
      productId: 'prod-1',
      status: 'done',
    })

    expect(callOrder).toEqual(['lock', 'update', 'updateMany'])
  })

  it('failed: bulk-cancelt overige QUEUED DEPLOY-jobs voor hetzelfde product in dezelfde tx', async () => {
    findManyResult = [{ id: 'queued-1' }, { id: 'queued-2' }]

    const result = await applyDeployTerminalUpdate({
      jobId: 'job-1',
      productId: 'prod-1',
      status: 'failed',
      error: 'ops-agent flow failed',
    })

    // Volgorde: lock → terminale update → siblings zoeken → bulk-cancel.
    expect(callOrder).toEqual(['lock', 'update', 'findMany', 'updateMany'])
    expect(updateManyCalls).toHaveLength(1)
    const args = updateManyCalls[0] as { where: { id: { in: string[] } }; data: { status: string } }
    expect(args.where.id.in).toEqual(['queued-1', 'queued-2'])
    expect(args.data.status).toBe('CANCELLED')
    expect(result.cancelledIds).toEqual(['queued-1', 'queued-2'])
  })

  it('failed: geen QUEUED-siblings ⇒ geen updateMany, lege cancelledIds', async () => {
    findManyResult = []

    const result = await applyDeployTerminalUpdate({
      jobId: 'job-1',
      productId: 'prod-1',
      status: 'failed',
      error: 'boom',
    })

    expect(callOrder).toEqual(['lock', 'update', 'findMany'])
    expect(updateManyCalls).toHaveLength(0)
    expect(result.cancelledIds).toEqual([])
  })

  it('done: licht oudere onopgeloste FAILED DEPLOY-jobs (resolved_at) voor hetzelfde product', async () => {
    await applyDeployTerminalUpdate({
      jobId: 'job-2',
      productId: 'prod-1',
      status: 'done',
    })

    expect(callOrder).toEqual(['lock', 'update', 'updateMany'])
    expect(updateManyCalls).toHaveLength(1)
    const args = updateManyCalls[0] as {
      where: { product_id: string; kind: string; status: string; resolved_at: null; id: { not: string } }
      data: { resolved_at: Date }
    }
    expect(args.where).toMatchObject({
      product_id: 'prod-1',
      kind: 'DEPLOY',
      status: 'FAILED',
      resolved_at: null,
      id: { not: 'job-2' },
    })
    expect(args.data.resolved_at).toBeInstanceOf(Date)
  })

  it('done: retourneert lege cancelledIds', async () => {
    const result = await applyDeployTerminalUpdate({
      jobId: 'job-2',
      productId: 'prod-1',
      status: 'done',
    })
    expect(result.cancelledIds).toEqual([])
  })
})
