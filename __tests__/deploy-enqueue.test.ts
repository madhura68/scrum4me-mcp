// M17 DEPLOY-job (spec §3): tests voor de orchestration-key-builder (pure
// helper) en het dedup-pad van maybeEnqueueDeployJob (unique-conflict op de
// partial index ⇒ 'dedup', T-1316-kwaliteitsreview). De volle
// lock-serialisatie wordt afgedekt in de interleaving-tests
// (__tests__/deploy-state-interleaving.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(() => Promise.resolve(0)),
  },
}))

import { prisma } from '../src/prisma.js'
import { buildDeployOrchestrationKey, maybeEnqueueDeployJob } from '../src/lib/dispatch/deploy-job.js'

const mockPrisma = prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }

describe('buildDeployOrchestrationKey', () => {
  it('bouwt auto:deploy:<owner>/<repo>#<idx>@<sha> uit een Forgejo-PR-url', () => {
    expect(
      buildDeployOrchestrationKey('https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/91', 'abc123'),
    ).toBe('auto:deploy:janpeter/Scrum4Me#91@abc123')
  })

  it('valt terug op de volledige url bij onbekend formaat', () => {
    expect(buildDeployOrchestrationKey('https://x/y', 'abc')).toBe('auto:deploy:https://x/y@abc')
  })
})

// Tx-handle waarin de create een unique-conflict gooit: lock + config +
// blokkade-check slagen, de insert botst op de partial unique index
// (claude_jobs_deploy_orchestration_key WHERE kind='DEPLOY').
function makeConflictTx(createError: unknown) {
  return {
    $executeRaw: vi.fn(() => Promise.resolve(0)),
    product: {
      findUnique: vi.fn(() => Promise.resolve({ auto_deploy: true, deploy_flow: 'server' })),
    },
    claudeJob: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(() => Promise.reject(createError)),
    },
  }
}

const enqueueOpts = {
  parentJobId: 'parent-1',
  userId: 'user-1',
  productId: 'prod-1',
  prUrl: 'https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/7',
  headSha: 'abc123',
}

describe('maybeEnqueueDeployJob dedup (unique-conflict op de partial index)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("Prisma P2002 op de create ⇒ 'dedup' (geen throw)", async () => {
    const p2002 = Object.assign(
      new Error('Unique constraint failed on the fields: (`orchestration_key`)'),
      { code: 'P2002' },
    )
    mockPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeConflictTx>) => Promise<unknown>) =>
        fn(makeConflictTx(p2002)),
    )

    await expect(maybeEnqueueDeployJob(enqueueOpts)).resolves.toBe('dedup')
  })

  it("raw Postgres 23505-boodschap ⇒ 'dedup'", async () => {
    const raw23505 = new Error(
      'db error: ERROR: duplicate key value violates unique constraint (SQLSTATE 23505)',
    )
    mockPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeConflictTx>) => Promise<unknown>) =>
        fn(makeConflictTx(raw23505)),
    )

    await expect(maybeEnqueueDeployJob(enqueueOpts)).resolves.toBe('dedup')
  })

  it('een niet-unique-conflict-fout wordt wél doorgegooid', async () => {
    const unrelated = new Error('connection reset by peer')
    mockPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeConflictTx>) => Promise<unknown>) =>
        fn(makeConflictTx(unrelated)),
    )

    await expect(maybeEnqueueDeployJob(enqueueOpts)).rejects.toThrow('connection reset by peer')
  })
})
