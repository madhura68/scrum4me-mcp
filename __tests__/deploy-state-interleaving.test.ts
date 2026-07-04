// M17 DEPLOY-job (spec §8, codex plan-r1 #6): bewijst dat de product-lock
// (pg_advisory_xact_lock(hashtext('deploy'), hashtext(productId))) twee
// schrijvers — applyDeployTerminalUpdate (failed-branch, T-1314) en
// maybeEnqueueDeployJob (T-1316) — écht serialiseert, in BEIDE volgordes.
// Zonder deze lock kan een enqueue een net-gefaalde DEPLOY "omzeilen"
// (blokkade-race) of kan een failed-branch een job missen die vlak ná de
// blokkade-check is aangemaakt (wees-job, nooit gecancelled).
//
// Fake-lock-harnas: prisma.$transaction wordt gemockt zodat de
// pg_advisory_xact_lock-call (de eerste tx.$executeRaw) een in-memory mutex
// per product-key claimt. De mutex geeft de lock pas vrij als de
// tx-callback resolvet — precies zoals Postgres een xact-lock vasthoudt tot
// commit. Een in-memory claude_jobs-array is de store waarop
// findFirst/findMany/create/update/updateMany opereren.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type FakeJob = {
  id: string
  product_id: string
  kind: string
  status: string
  resolved_at: Date | null
  error: string | null
  summary: string | null
  pr_url: string | null
  finished_at: Date | null
}

// ---------------------------------------------------------------------------
// In-memory mutex per product-key (deferred-based — echte async serialisatie,
// geen synchrone stub). Elke aanvraag wacht op de vorige holder's release.
// ---------------------------------------------------------------------------
function createProductMutex() {
  const queues = new Map<string, Promise<void>>()

  return {
    // Retourneert een release-functie zodra de lock verworven is. De caller
    // moet release() aanroepen zodra de tx-callback klaar is (net als een
    // Postgres-commit de xact-lock vrijgeeft).
    async acquire(productKey: string): Promise<() => void> {
      const previous = queues.get(productKey) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      queues.set(
        productKey,
        previous.then(() => current),
      )
      await previous
      return release
    },
  }
}

let mutex: ReturnType<typeof createProductMutex>
let jobs: FakeJob[]
let products: Map<string, { auto_deploy: boolean; deploy_flow: string | null }>
// Volgorde-log over BEIDE concurrent transacties heen (gedeeld, net als het
// callOrder-patroon in __tests__/update-job-status-deploy.test.ts) zodat de
// asserts de daadwerkelijke interleaving bewijzen, niet alleen het eindresultaat.
let callOrder: string[]

function makeTxHandle(productId: string) {
  return {
    $executeRaw: vi.fn((..._args: unknown[]) => Promise.resolve(0)),
    product: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        const p = products.get(where.id)
        return Promise.resolve(p ? { auto_deploy: p.auto_deploy, deploy_flow: p.deploy_flow } : null)
      }),
    },
    claudeJob: {
      findFirst: vi.fn(
        ({ where }: { where: { product_id: string; kind: string; status: string; resolved_at: null } }) => {
          const match = jobs.find(
            (j) =>
              j.product_id === where.product_id &&
              j.kind === where.kind &&
              j.status === where.status &&
              j.resolved_at === null,
          )
          return Promise.resolve(match ? { id: match.id } : null)
        },
      ),
      findMany: vi.fn(({ where }: { where: { product_id: string; kind: string; status: string } }) => {
        const matches = jobs.filter(
          (j) => j.product_id === where.product_id && j.kind === where.kind && j.status === where.status,
        )
        return Promise.resolve(matches.map((j) => ({ id: j.id })))
      }),
      create: vi.fn(
        ({
          data,
        }: {
          data: {
            product_id: string
            kind: string
            orchestration_key?: string | null
            pr_url?: string | null
            head_sha?: string | null
          }
        }) => {
          const id = `deploy-${jobs.length + 1}`
          const job: FakeJob = {
            id,
            product_id: data.product_id,
            kind: data.kind,
            status: 'QUEUED',
            resolved_at: null,
            error: null,
            summary: null,
            pr_url: data.pr_url ?? null,
            finished_at: null,
          }
          jobs.push(job)
          return Promise.resolve({ id })
        },
      ),
      update: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string }
          data: { status: string; summary?: string | null; error?: string | null }
        }) => {
          const job = jobs.find((j) => j.id === where.id)
          if (!job) throw new Error(`fake-store: job ${where.id} not found`)
          job.status = data.status
          if (data.summary !== undefined) job.summary = data.summary ?? null
          if (data.error !== undefined) job.error = data.error ?? null
          job.finished_at = new Date()
          return Promise.resolve({
            id: job.id,
            status: job.status,
            summary: job.summary,
            error: job.error,
            pr_url: job.pr_url,
          })
        },
      ),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: {
            id?: { in?: string[]; not?: string }
            product_id?: string
            kind?: string
            status?: string
            resolved_at?: null
          }
          data: { status?: string; error?: string; resolved_at?: Date }
        }) => {
          let targets: FakeJob[]
          if (where.id?.in) {
            const ids = where.id.in
            targets = jobs.filter((j) => ids.includes(j.id))
          } else {
            targets = jobs.filter(
              (j) =>
                (!where.product_id || j.product_id === where.product_id) &&
                (!where.kind || j.kind === where.kind) &&
                (!where.status || j.status === where.status) &&
                (where.resolved_at === undefined || j.resolved_at === where.resolved_at) &&
                (!where.id?.not || j.id !== where.id.not),
            )
          }
          for (const t of targets) {
            if (data.status) t.status = data.status
            if (data.error !== undefined) t.error = data.error
            if (data.resolved_at !== undefined) t.resolved_at = data.resolved_at
          }
          return Promise.resolve({ count: targets.length })
        },
      ),
    },
  }
}

// productId wordt gebruikt als mutex-key (in de echte code is dat
// hashtext(productId) — voor de test-mutex volstaat de rauwe productId als
// key, want de test claimt zelf nooit twee verschillende producten).
function mockTransaction(
  label: string,
  productId: string,
  opts: { holdUntil?: Promise<void> } = {},
) {
  return vi.fn(async (fn: (tx: ReturnType<typeof makeTxHandle>) => Promise<unknown>) => {
    callOrder.push(`${label}:wait-lock`)
    const release = await mutex.acquire(productId)
    callOrder.push(`${label}:acquired-lock`)
    try {
      const tx = makeTxHandle(productId)
      // De queries in de tx-callback draaien meteen (net als in een echte
      // Postgres-transactie: de statements voeren al uit vóór commit). Pas
      // ná de callback hangt de "commit" op een deferred als de test er een
      // meegeeft — de lock blijft ondertussen vast, exact zoals een
      // Postgres-transactie die nog niet gecommit heeft haar xact-lock
      // vasthoudt terwijl de rijen al gemuteerd zijn (maar nog niet
      // zichtbaar zijn voor andere transacties totdat commit vrijgeeft).
      const result = await fn(tx)
      if (opts.holdUntil) {
        callOrder.push(`${label}:tx-done-holding-before-commit`)
        await opts.holdUntil
      }
      callOrder.push(`${label}:tx-resolved`)
      return result
    } finally {
      release()
      callOrder.push(`${label}:released-lock`)
    }
  })
}

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    // notifyJobEnqueued (buiten de transactie, ná commit) doet zijn eigen
    // pg_notify via prisma.$executeRaw — best-effort/non-fatal in de echte
    // code, maar moet hier gewoon een resolved promise zijn zodat de
    // interleaving-asserts niet worden gestoord door een irrelevante mock-fout.
    $executeRaw: vi.fn(() => Promise.resolve(0)),
  },
}))

import { prisma } from '../src/prisma.js'
import { applyDeployTerminalUpdate } from '../src/tools/update-job-status.js'
import { maybeEnqueueDeployJob } from '../src/lib/dispatch/deploy-job.js'

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  mutex = createProductMutex()
  jobs = []
  products = new Map()
  callOrder = []
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// Flush de microtask-queue een aantal keer — nodig omdat
// maybeEnqueueDeployJob/applyDeployTerminalUpdate meerdere geneste awaits
// hebben vóór ze de mock-transactie daadwerkelijk aanroepen; een vast aantal
// losse `await Promise.resolve()`-ticks is fragiel bij refactors.
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('DEPLOY state-interleaving (spec §8): product-lock serialiseert failed-branch vs enqueue', () => {
  it('volgorde A: failed-branch houdt de lock; enqueue die wacht ziet daarna de FAILED ⇒ blocked, geen blok-omzeiling', async () => {
    const productId = 'prod-A'
    products.set(productId, { auto_deploy: true, deploy_flow: 'server-a' })
    jobs.push({
      id: 'job-running',
      product_id: productId,
      kind: 'DEPLOY',
      status: 'RUNNING',
      resolved_at: null,
      error: null,
      summary: null,
      pr_url: 'https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/1',
      finished_at: null,
    })

    const holdGate = deferred()

    // Eerste caller: applyDeployTerminalUpdate('failed') pakt de lock eerst en
    // blijft hem vasthouden tot holdGate.resolve() (simuleert een tx die nog
    // niet gecommit heeft terwijl de tweede caller al op de mutex wacht).
    mockPrisma.$transaction.mockImplementationOnce(
      mockTransaction('failed-branch', productId, { holdUntil: holdGate.promise }),
    )
    // Tweede caller: maybeEnqueueDeployJob voor hetzelfde product — moet
    // wachten tot de eerste de lock vrijgeeft.
    mockPrisma.$transaction.mockImplementationOnce(mockTransaction('enqueue', productId))

    const failedPromise = applyDeployTerminalUpdate({
      jobId: 'job-running',
      productId,
      status: 'failed',
      error: 'ops-agent flow failed',
    })

    // Geef de event-loop een tick zodat de eerste transactie daadwerkelijk de
    // lock heeft verworven en op holdGate hangt vóórdat de tweede start.
    await flushMicrotasks()

    const enqueuePromise = maybeEnqueueDeployJob({
      parentJobId: 'parent-job',
      userId: 'user-1',
      productId,
      prUrl: 'https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/2',
      headSha: 'sha-a',
    })

    // Nog geen van beide is klaar: de enqueue moet op de mutex wachten.
    await flushMicrotasks()
    expect(callOrder).toContain('enqueue:wait-lock')
    expect(callOrder).not.toContain('enqueue:acquired-lock')

    // Laat de failed-branch zijn transactie afronden (commit) → lock vrij.
    holdGate.resolve()

    const [failedResult, enqueueResult] = await Promise.all([failedPromise, enqueuePromise])

    // De lock is écht serialiserend geweest: failed-branch verwierf hem
    // eerst en gaf hem pas vrij nádat zijn tx-callback resolvete; pas daarna
    // kon de enqueue-tx starten.
    const failedAcquiredIdx = callOrder.indexOf('failed-branch:acquired-lock')
    const failedReleasedIdx = callOrder.indexOf('failed-branch:released-lock')
    const enqueueAcquiredIdx = callOrder.indexOf('enqueue:acquired-lock')
    expect(failedAcquiredIdx).toBeGreaterThanOrEqual(0)
    expect(failedReleasedIdx).toBeGreaterThan(failedAcquiredIdx)
    expect(enqueueAcquiredIdx).toBeGreaterThan(failedReleasedIdx)

    // Uitkomst: de failed-transitie ging door (geen queued siblings, dus
    // cancelledIds leeg); de enqueue zag de zojuist geschreven FAILED
    // (resolved_at=null) en werd geblokkeerd — GEEN blok-omzeiling.
    expect(failedResult.updated.status).toBe('FAILED')
    expect(failedResult.cancelledIds).toEqual([])
    expect(enqueueResult).toBe('blocked')

    // Geen nieuwe QUEUED-rij: alleen de oorspronkelijke (nu FAILED) job bestaat.
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe('FAILED')
  })

  it('volgorde B: enqueue houdt de lock en maakt de QUEUED-rij; failed-branch die wacht cancelt daarna de verse rij (geen wees-job)', async () => {
    const productId = 'prod-B'
    products.set(productId, { auto_deploy: true, deploy_flow: 'server-b' })
    jobs.push({
      id: 'job-running',
      product_id: productId,
      kind: 'DEPLOY',
      status: 'RUNNING',
      resolved_at: null,
      error: null,
      summary: null,
      pr_url: 'https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/3',
      finished_at: null,
    })

    const holdGate = deferred()

    // Eerste caller: maybeEnqueueDeployJob pakt de lock eerst, maakt de
    // QUEUED-rij aan, en blijft de lock vasthouden tot holdGate.resolve().
    mockPrisma.$transaction.mockImplementationOnce(
      mockTransaction('enqueue', productId, { holdUntil: holdGate.promise }),
    )
    // Tweede caller: applyDeployTerminalUpdate('failed') voor hetzelfde
    // product — moet wachten tot de enqueue de lock vrijgeeft.
    mockPrisma.$transaction.mockImplementationOnce(mockTransaction('failed-branch', productId))

    const enqueuePromise = maybeEnqueueDeployJob({
      parentJobId: 'job-running',
      userId: 'user-1',
      productId,
      prUrl: 'https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/4',
      headSha: 'sha-b',
    })

    await flushMicrotasks()

    const failedPromise = applyDeployTerminalUpdate({
      jobId: 'job-running',
      productId,
      status: 'failed',
      error: 'ops-agent flow failed',
    })

    await flushMicrotasks()
    expect(callOrder).toContain('failed-branch:wait-lock')
    expect(callOrder).not.toContain('failed-branch:acquired-lock')

    // De QUEUED-rij bestaat al (binnen de enqueue-tx aangemaakt), maar de
    // enqueue-tx heeft nog niet gecommit — failed-branch mag hem nog niet zien.
    const freshJobBeforeCommit = jobs.find((j) => j.status === 'QUEUED')
    expect(freshJobBeforeCommit).toBeDefined()
    const freshJobId = freshJobBeforeCommit!.id

    holdGate.resolve()

    const [enqueueResult, failedResult] = await Promise.all([enqueuePromise, failedPromise])

    const enqueueAcquiredIdx = callOrder.indexOf('enqueue:acquired-lock')
    const enqueueReleasedIdx = callOrder.indexOf('enqueue:released-lock')
    const failedAcquiredIdx = callOrder.indexOf('failed-branch:acquired-lock')
    expect(enqueueAcquiredIdx).toBeGreaterThanOrEqual(0)
    expect(enqueueReleasedIdx).toBeGreaterThan(enqueueAcquiredIdx)
    expect(failedAcquiredIdx).toBeGreaterThan(enqueueReleasedIdx)

    expect(enqueueResult).toBe('enqueued')
    // De verse QUEUED-rij wordt door de failed-branch gecancelled — géén
    // wees-job die voor altijd QUEUED blijft staan.
    expect(failedResult.cancelledIds).toEqual([freshJobId])
    const freshJob = jobs.find((j) => j.id === freshJobId)
    expect(freshJob?.status).toBe('CANCELLED')
  })
})
