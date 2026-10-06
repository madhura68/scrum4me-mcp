import { it, expect, vi, beforeEach } from 'vitest'

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  ideaChatMessage: { create: vi.fn() },
  claudeJob: { findFirst: vi.fn(), create: vi.fn() },
  ideaLog: { create: vi.fn() },
  // M45-2b: de enqueue leest de productkeuze (readHarnessChoice) op de transactieclient.
  productHarnessChoice: { findUnique: vi.fn() },
}))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    idea: { findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  },
}))
// PermissionDeniedError: withToolErrors vergelijkt een gegooide fout met deze klasse (de leesfout-test hieronder).
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { notifyJobEnqueued } from '../src/lib/dispatch/notify.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerSendIdeaChatMessageTool } from '../src/tools/send-idea-chat-message.js'

function makeStub() {
  let handler: ((input: Record<string, unknown>) => Promise<unknown>) | undefined
  const server = {
    registerTool: vi.fn((_n: string, _m: unknown, h: typeof handler) => {
      handler = h
    }),
  } as unknown as McpServer
  registerSendIdeaChatMessageTool(server)
  return { call: (input: Record<string, unknown>) => handler!(input) }
}
const stub = makeStub()
const parse = (r: { content: [{ text: string }] }) => JSON.parse(r.content[0].text)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireWriteAccess).mockResolvedValue({ userId: 'u1' } as never)
  vi.mocked(userCanAccessProduct).mockResolvedValue(true)
  vi.mocked(prisma.idea.findUnique).mockResolvedValue({ user_id: 'u1', product_id: 'p1' } as never)
  vi.mocked(prisma.product.findUnique).mockResolvedValue({ content_policy: null } as never)
  // `as never` zoals bij de mockResolvedValue-regels hierboven: de tx-stub dekt
  // alleen de modellen die deze tool aanraakt, niet de volledige PrismaClient
  // die $transaction's signatuur eist.
  vi.mocked(prisma.$transaction).mockImplementation(
    (async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) as never,
  )
  tx.$queryRaw.mockResolvedValue([{ id: 'i1', product_id: 'p1' }])
  tx.ideaChatMessage.create.mockResolvedValue({ id: 'm1' })
  tx.claudeJob.findFirst.mockResolvedValue(null)
  tx.claudeJob.create.mockResolvedValue({ id: 'j1' })
  tx.ideaLog.create.mockResolvedValue({ id: 'l1' })
  tx.productHarnessChoice.findUnique.mockResolvedValue(null)
})

it('happy path: lock → persist → enqueue → notify ná de tx', async () => {
  const body = parse((await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })) as never)
  expect(body).toEqual({ message_id: 'm1', job_enqueued: true, coalesced: false })
  expect(tx.$queryRaw).toHaveBeenCalled()
  expect(notifyJobEnqueued).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'j1', kind: 'IDEA_CHAT' }))
})

it('job-create zet géén source-override: default SYSTEM is vereist door de isSystemIdeaChat-guard (codex r1-P1)', async () => {
  await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })
  expect(tx.claudeJob.create.mock.calls[0][0].data).not.toHaveProperty('source')
})

it('product ontkoppeld ONDER de lock (product_id null) → persist-only, geen job (web-pariteit)', async () => {
  tx.$queryRaw.mockResolvedValue([{ id: 'i1', product_id: null }])
  const body = parse((await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })) as never)
  expect(body).toEqual({ message_id: 'm1', job_enqueued: false, coalesced: false })
  expect(tx.claudeJob.create).not.toHaveBeenCalled()
})

it('product gewijzigd ONDER de lock → not-found-fout, tx teruggerold (geen persist)', async () => {
  tx.$queryRaw.mockResolvedValue([{ id: 'i1', product_id: 'ander' }])
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })) as {
    isError?: boolean
    content: [{ text: string }]
  }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/not found/i)
})

it('coalescing: actieve IDEA_CHAT-job → persist zonder tweede job, geen notify', async () => {
  tx.claudeJob.findFirst.mockResolvedValue({ id: 'lopend' })
  const body = parse((await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })) as never)
  expect(body).toEqual({ message_id: 'm1', job_enqueued: false, coalesced: true })
  expect(tx.claudeJob.create).not.toHaveBeenCalled()
  expect(notifyJobEnqueued).not.toHaveBeenCalled()
})

it('enqueue:false (kill-switch): persist-only, geen job-query en geen notify', async () => {
  const body = parse((await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi', enqueue: false })) as never)
  expect(body).toEqual({ message_id: 'm1', job_enqueued: false, coalesced: false })
  expect(tx.claudeJob.create).not.toHaveBeenCalled()
  expect(notifyJobEnqueued).not.toHaveBeenCalled()
})

it('content-policy: verboden term → weigering ZONDER persist (fail-closed pad, spec §3.6)', async () => {
  vi.mocked(prisma.product.findUnique).mockResolvedValue({ content_policy: { forbiddenFields: ['bsn'] } } as never)
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'sla het bsn op' })) as {
    isError?: boolean
    content: [{ text: string }]
  }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/AVG/)
  expect(tx.ideaChatMessage.create).not.toHaveBeenCalled()
})

it('P2002 op de vangrail-index → "already active"-conflict (service mapt 409)', async () => {
  const err = Object.assign(new Error('unique'), { code: 'P2002' })
  vi.mocked(prisma.$transaction).mockRejectedValue(err)
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })) as {
    isError?: boolean
    content: [{ text: string }]
  }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/already active/i)
})

it('productgrens-mismatch (pre-lock) → "Idea not found", tx niet geopend', async () => {
  vi.mocked(prisma.idea.findUnique).mockResolvedValue({ user_id: 'u1', product_id: 'ander' } as never)
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })) as { isError?: boolean }
  expect(res.isError).toBe(true)
  expect(prisma.$transaction).not.toHaveBeenCalled()
})

// ── M45-2b Taak 4: de enqueue volgt de productkeuze (spec §5.2) ──────────────────────────────────────────────
// Met een keuze voor (product, IDEA_CHAT) wordt de beurt een HARNESS-job met de gekozen configuratie. Zonder keuze
// blijft het create-object exact zoals vóór M45: geen runtime, geen requested_model, geen source.
const CHOICE = { configuration: 'gsq-lokaal', max_cost_usd: '0.0500' }
const PLAIN_JOB_DATA = { user_id: 'u1', product_id: 'p1', idea_id: 'i1', kind: 'IDEA_CHAT', status: 'QUEUED' }

it('met een keuze: de job krijgt runtime HARNESS en de gekozen configuratie als requested_model', async () => {
  tx.productHarnessChoice.findUnique.mockResolvedValue(CHOICE)
  const body = parse((await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })) as never)

  expect(body).toEqual({ message_id: 'm1', job_enqueued: true, coalesced: false })
  expect(tx.claudeJob.create.mock.calls[0][0]).toStrictEqual({
    data: { ...PLAIN_JOB_DATA, runtime: 'HARNESS', requested_model: 'gsq-lokaal' },
    select: { id: true },
  })
  expect(notifyJobEnqueued).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'j1', kind: 'IDEA_CHAT' }))
})

it('zonder keuze: het create-object is exact dat van vóór M45 (geen runtime, geen requested_model, geen source)', async () => {
  await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })

  expect(tx.claudeJob.create.mock.calls[0][0]).toStrictEqual({ data: PLAIN_JOB_DATA, select: { id: true } })
})

it('de keuze wordt op de transactieclient gelezen, voor (product, IDEA_CHAT), na de coalescing-check en vóór de create', async () => {
  await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })

  expect(tx.productHarnessChoice.findUnique).toHaveBeenCalledTimes(1)
  expect(tx.productHarnessChoice.findUnique).toHaveBeenCalledWith(expect.objectContaining({
    where: { product_id_kind: { product_id: 'p1', kind: 'IDEA_CHAT' } },
  }))
  const read = tx.productHarnessChoice.findUnique.mock.invocationCallOrder[0]
  expect(tx.claudeJob.findFirst.mock.invocationCallOrder[0]).toBeLessThan(read)
  expect(read).toBeLessThan(tx.claudeJob.create.mock.invocationCallOrder[0])
})

it('coalescing en persist-only lezen de keuze niet: er komt geen job', async () => {
  tx.claudeJob.findFirst.mockResolvedValue({ id: 'lopend' })
  await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })
  await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi', enqueue: false })
  tx.claudeJob.findFirst.mockResolvedValue(null)
  tx.$queryRaw.mockResolvedValue([{ id: 'i1', product_id: null }])
  await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })

  expect(tx.productHarnessChoice.findUnique).not.toHaveBeenCalled()
  expect(tx.claudeJob.create).not.toHaveBeenCalled()
})

it('een leesfout van de keuze is geen "geen keuze": de send mislukt, er komt geen job en geen melding', async () => {
  tx.productHarnessChoice.findUnique.mockRejectedValue(new Error('READ_FAILED'))
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1', content: 'hoi' })) as {
    isError?: boolean
    content: [{ text: string }]
  }

  expect(res.isError).toBe(true)
  expect(res.content[0].text).toBe('READ_FAILED')
  expect(tx.claudeJob.create).not.toHaveBeenCalled()
  expect(notifyJobEnqueued).not.toHaveBeenCalled()
})
