// M17 Task 3.6: tests voor dispatchDeploy (mcp-spiegel van de web-action
// deployNowAction). Zelfde lock-vóór-read callOrder-conventie als de eerdere
// deploy-tests (T-1314/T-1316, __tests__/deploy-state-interleaving.test.ts):
// een gedeeld callOrder-array bewijst dat de advisory-lock als eerste query
// binnen de transactie gebeurt — mutatie-bestendig (schuift iemand de lock
// ná de reads, dan faalt de volgorde-assert, niet alleen de eind-uitkomst).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { callOrder, mockTransaction, mockTxExecuteRaw, mockFindUnique, mockFindFirst, mockCreate, mockExecuteRaw } =
  vi.hoisted(() => {
    const callOrder: string[] = []
    return {
      callOrder,
      mockTransaction: vi.fn(),
      mockTxExecuteRaw: vi.fn(async () => {
        callOrder.push('lock')
        return 0
      }),
      mockFindUnique: vi.fn(async () => {
        callOrder.push('findProduct')
        return { deploy_flow: 'update_scrum4me_web' }
      }),
      mockFindFirst: vi.fn(async () => {
        callOrder.push('findJob')
        return null
      }),
      mockCreate: vi.fn(async () => {
        callOrder.push('create')
        return { id: 'job-1' }
      }),
      mockExecuteRaw: vi.fn().mockResolvedValue(0),
    }
  })

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: mockTransaction,
    $executeRaw: mockExecuteRaw,
  },
}))

import { dispatchDeploy } from '../src/lib/dispatch/deploy-dispatch.js'
import { DispatchError } from '../src/lib/dispatch/errors.js'

const OPTS = { productId: 'prod-1', userId: 'user-1' }

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
  // Expliciete default-implementaties per test (i.p.v. leunen op de
  // vi.hoisted-fabrieksdefaults): clearAllMocks wist call-historie maar geen
  // custom mockImplementation, dus een override in één test zou anders
  // lekken naar de volgende als we niet elke keer opnieuw baselinen.
  mockTxExecuteRaw.mockImplementation(async () => {
    callOrder.push('lock')
    return 0
  })
  mockFindUnique.mockImplementation(async () => {
    callOrder.push('findProduct')
    return { deploy_flow: 'update_scrum4me_web' }
  })
  mockFindFirst.mockImplementation(async () => {
    callOrder.push('findJob')
    return null
  })
  mockCreate.mockImplementation(async () => {
    callOrder.push('create')
    return { id: 'job-1' }
  })
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $executeRaw: mockTxExecuteRaw,
      product: { findUnique: mockFindUnique },
      claudeJob: { findFirst: mockFindFirst, create: mockCreate },
    }),
  )
})

describe('dispatchDeploy', () => {
  it('lock vóór config-read vóór active-job-guard vóór create', async () => {
    const result = await dispatchDeploy(OPTS)
    expect(result).toEqual({ job_id: 'job-1' })
    expect(callOrder).toEqual(['lock', 'findProduct', 'findJob', 'create'])
  })

  it('create-shape: MANUAL bron, deploy-capability, geen requested_*-snapshot', async () => {
    await dispatchDeploy(OPTS)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'DEPLOY',
          status: 'QUEUED',
          source: 'MANUAL',
          runtime: 'CLAUDE',
          required_capability: 'deploy',
        }),
      }),
    )
    const call = mockCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data).not.toHaveProperty('requested_model')
    expect(call.data).not.toHaveProperty('requested_thinking_budget')
    expect(call.data).not.toHaveProperty('requested_permission_mode')
    expect(call.data).not.toHaveProperty('orchestration_key')
  })

  it('weigert zonder deploy_flow (gelezen binnen de lock) — DispatchError', async () => {
    mockFindUnique.mockImplementation(async () => {
      callOrder.push('findProduct')
      return { deploy_flow: null }
    })
    await expect(dispatchDeploy(OPTS)).rejects.toThrow(DispatchError)
    await expect(dispatchDeploy(OPTS)).rejects.toThrow(/deploy_flow/)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(callOrder[0]).toBe('lock')
  })

  it('weigert bij een actieve DEPLOY-job (active-job-guard) — DispatchError', async () => {
    mockFindFirst.mockImplementation(async () => {
      callOrder.push('findJob')
      return { id: 'busy-job' }
    })
    await expect(dispatchDeploy(OPTS)).rejects.toThrow(DispatchError)
    await expect(dispatchDeploy(OPTS)).rejects.toThrow(/loopt al een deploy/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('active-job-guard filtert op QUEUED/CLAIMED/RUNNING (ACTIVE_JOB_STATUSES)', async () => {
    await dispatchDeploy(OPTS)
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          product_id: 'prod-1',
          kind: 'DEPLOY',
          status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] },
        }),
      }),
    )
  })
})
