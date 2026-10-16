import { it, expect, vi, beforeEach } from 'vitest'

// Taak 3 (afsluiten met status PLANNED): de interactieve $transaction krijgt een
// eigen tx-mock, los van de prisma.*-mocks, zodat "geen directe update" en
// "geen tx-update" elk iets betekenen.
const txMocks = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  idea: { findUnique: vi.fn(), update: vi.fn() },
  claudeJob: { findFirst: vi.fn() },
  ideaLog: { create: vi.fn() },
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    idea: { findFirst: vi.fn(), update: vi.fn() },
    ideaChatMessage: { create: vi.fn() },
    claudeJob: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    constructor(message = 'Demo accounts cannot perform write operations') {
      super(message)
      this.name = 'PermissionDeniedError'
    }
  },
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess, PermissionDeniedError } from '../src/auth.js'
import { handleUpdateIdea } from '../src/tools/update-idea.js'
import { toolText } from './helpers/tool-result.js'
import type { AnyMock } from './helpers/mocks.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockProduct = (prisma as unknown as { product: { findUnique: ReturnType<typeof vi.fn> } })
  .product.findUnique
const mockFind = (prisma as unknown as { idea: { findFirst: ReturnType<typeof vi.fn> } })
  .idea.findFirst
const mockUpdate = (prisma as unknown as { idea: { update: ReturnType<typeof vi.fn> } })
  .idea.update
const mockChatMessage = (prisma as unknown as {
  ideaChatMessage: { create: ReturnType<typeof vi.fn> }
}).ideaChatMessage.create
const mockJobFind = (prisma as unknown as { claudeJob: { findFirst: ReturnType<typeof vi.fn> } })
  .claudeJob.findFirst
const mockTransaction = (prisma as unknown as { $transaction: AnyMock }).$transaction

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockProduct.mockResolvedValue({ content_policy: null })
  mockFind.mockResolvedValue({ id: 'idea-1', status: 'DRAFT' })
  mockUpdate.mockResolvedValue({ id: 'idea-1', code: 'IDEA-042', status: 'DRAFT' })
  mockChatMessage.mockResolvedValue({ id: 'msg-1' })
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMocks))
  txMocks.$queryRaw.mockResolvedValue([{ id: 'idea-1' }])
  txMocks.idea.findUnique.mockResolvedValue({ status: 'PLAN_READY' })
  txMocks.claudeJob.findFirst.mockResolvedValue(null)
  txMocks.idea.update.mockResolvedValue({ id: 'idea-1', code: 'IDEA-042', status: 'PLANNED' })
  txMocks.ideaLog.create.mockResolvedValue({ id: 'log-1' })
})

it('werkt titel/beschrijving bij (happy path)', async () => {
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    title: 'Nieuwe titel',
    description: 'Nieuwe omschrijving',
  })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ id: 'idea-1', code: 'IDEA-042' })
  expect(mockUpdate).toHaveBeenCalledWith({
    where: { id: 'idea-1' },
    data: { title: 'Nieuwe titel', description: 'Nieuwe omschrijving' },
    select: { id: true, code: true, status: true },
  })
  // M17 idea-chat: doc-update zichtbaar als SYSTEM/DOC_UPDATE-kanaalbericht.
  expect(mockChatMessage).toHaveBeenCalledWith({
    data: {
      idea_id: 'idea-1',
      role: 'SYSTEM',
      kind: 'DOC_UPDATE',
      content: 'Beschrijving bijgewerkt door de agent',
      metadata: { fields: ['title', 'description'] },
    },
  })
})

it('accepteert een beschrijving van precies 64.000 tekens', async () => {
  const description = 'x'.repeat(64_000)
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    description,
  })

  expect(res.isError).toBeFalsy()
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
    data: { description },
  }))
})

it('weigert 64.001 tekens met een bruikbare grensmelding', async () => {
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    description: 'x'.repeat(64_001),
  })

  expect(res.isError).toBe(true)
  expect(toolText(res)).toContain(
    'Beschrijving bevat 64.001 tekens; verwijder 1 teken. Maximaal 64.000 toegestaan.',
  )
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('telt een emoji als één teken op de grens van 64.000', async () => {
  const description = `${'x'.repeat(63_999)}😀`
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    description,
  })

  expect(res.isError).toBeFalsy()
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
    data: { description },
  }))
})

it('meldt Unicode-overloop in tekens in plaats van UTF-16-eenheden', async () => {
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    description: `${'x'.repeat(64_000)}😀`,
  })

  expect(res.isError).toBe(true)
  expect(toolText(res)).toContain(
    'Beschrijving bevat 64.001 tekens; verwijder 1 teken. Maximaal 64.000 toegestaan.',
  )
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('een falende kanaalbericht-write laat de idea-update slagen (best-effort)', async () => {
  mockChatMessage.mockRejectedValue(new Error('db weg'))
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    title: 'Nieuwe titel',
  })
  expect(res.isError).toBeFalsy()
  expect(mockUpdate).toHaveBeenCalled()
})

it('eist minstens één van title/description', async () => {
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/VALIDATION_ERROR/)
  expect(toolText(res)).toContain('minstens één van title, description of status is vereist')
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert een verboden veld tegen de product content_policy (AVG)', async () => {
  mockProduct.mockResolvedValue({
    content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] },
  })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'Voeg een bsn-veld toe' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/AVG.*bsn/)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('faalt closed bij een malformed content_policy', async () => {
  mockProduct.mockResolvedValue({ content_policy: { forbiddenFields: 'bsn' } })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'Iets onschuldigs' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/content_policy|configuratie/i)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert een idee buiten product/pool (cross-product/ownership, 404-stijl)', async () => {
  mockFind.mockResolvedValue(null)
  const res = await handleUpdateIdea({ idea_id: 'idea-x', product_id: 'prod-2', title: 'T' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/not found/i)
  expect(mockFind).toHaveBeenCalledWith({
    where: { id: 'idea-x', user_id: 'user-1', product_id: 'prod-2' },
    select: { id: true, code: true, status: true },
  })
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert bewerken bij een niet-editable status', async () => {
  mockFind.mockResolvedValue({ id: 'idea-1', status: 'GRILLING' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'T' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/GRILLING/)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert demo-accounts (PERMISSION_DENIED)', async () => {
  mockAuth.mockRejectedValue(new PermissionDeniedError())
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'T' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/PERMISSION_DENIED/)
})

// --- Taak 3: afsluiten met status PLANNED -------------------------------------

const CLOSE_BLOCKING_KINDS = [
  'IDEA_GRILL',
  'IDEA_MAKE_SPEC',
  'IDEA_REVISE_SPEC',
  'SPEC_REVIEW',
  'IDEA_MAKE_PLAN',
  'IDEA_REVIEW_PLAN',
  'IDEA_CHAT',
]

it('zet status PLANNED vanuit PLAN_READY en logt STATUS_CHANGE', async () => {
  mockFind.mockResolvedValue({ id: 'idea-1', code: 'IDEA-042', status: 'PLAN_READY' })
  txMocks.idea.findUnique.mockResolvedValue({ status: 'PLAN_READY' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toEqual({ id: 'idea-1', code: 'IDEA-042', status: 'PLANNED' })
  expect(txMocks.claudeJob.findFirst).toHaveBeenCalledWith({
    where: {
      idea_id: 'idea-1',
      kind: { in: CLOSE_BLOCKING_KINDS },
      status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] },
    },
    select: { id: true, kind: true },
  })
  expect(txMocks.idea.update).toHaveBeenCalledWith({
    where: { id: 'idea-1' },
    data: { status: 'PLANNED' },
    select: { id: true, code: true, status: true },
  })
  expect(txMocks.ideaLog.create).toHaveBeenCalledWith({
    data: {
      idea_id: 'idea-1',
      type: 'STATUS_CHANGE',
      content: 'Status PLAN_READY → PLANNED (update_idea)',
      metadata: { from: 'PLAN_READY', to: 'PLANNED', via: 'update_idea' },
    },
  })
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('zet PLANNED vanuit DRAFT (interactief pad)', async () => {
  txMocks.idea.findUnique.mockResolvedValue({ status: 'DRAFT' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ status: 'PLANNED' })
  expect(txMocks.idea.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { status: 'PLANNED' } }),
  )
  expect(txMocks.ideaLog.create).toHaveBeenCalledWith({
    data: {
      idea_id: 'idea-1',
      type: 'STATUS_CHANGE',
      content: 'Status DRAFT → PLANNED (update_idea)',
      metadata: { from: 'DRAFT', to: 'PLANNED', via: 'update_idea' },
    },
  })
})

it('weigert PLANNED bij een actieve pipeline-SPEC_REVIEW (met idea_id)', async () => {
  txMocks.idea.findUnique.mockResolvedValue({ status: 'DRAFT' })
  txMocks.claudeJob.findFirst.mockResolvedValue({ id: 'job-1', kind: 'SPEC_REVIEW' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toContain('SPEC_REVIEW')
  expect(toolText(res)).toContain('job-1')
  expect(toolText(res)).toBe(
    'Idee kan niet worden afgesloten: er loopt nog een SPEC_REVIEW-job (job-1) — wacht tot die klaar is of annuleer hem',
  )
  expect(txMocks.idea.update).not.toHaveBeenCalled()
  expect(txMocks.ideaLog.create).not.toHaveBeenCalled()
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert PLANNED tijdens een lopende IDEA_CHAT-beurt', async () => {
  txMocks.idea.findUnique.mockResolvedValue({ status: 'DRAFT' })
  txMocks.claudeJob.findFirst.mockResolvedValue({ id: 'job-2', kind: 'IDEA_CHAT' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toContain('IDEA_CHAT')
  expect(toolText(res)).toContain('job-2')
  expect(txMocks.idea.update).not.toHaveBeenCalled()
  expect(txMocks.ideaLog.create).not.toHaveBeenCalled()
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('title-only update doet geen jobcheck', async () => {
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'Nieuwe titel' })
  expect(res.isError).toBeFalsy()
  expect(mockTransaction).not.toHaveBeenCalled()
  expect(mockJobFind).not.toHaveBeenCalled()
  expect(txMocks.claudeJob.findFirst).not.toHaveBeenCalled()
  expect(mockUpdate).toHaveBeenCalledWith({
    where: { id: 'idea-1' },
    data: { title: 'Nieuwe titel' },
    select: { id: true, code: true, status: true },
  })
})

it('status-pad: lock vóór herlezing en jobcheck, alles in één transactie', async () => {
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBeFalsy()
  expect(mockTransaction).toHaveBeenCalledTimes(1)
  const lockSql = (txMocks.$queryRaw.mock.calls[0][0] as readonly string[]).join('?')
  expect(lockSql).toContain('FOR UPDATE')
  expect(lockSql).toContain('ideas')
  const order = [
    txMocks.$queryRaw.mock.invocationCallOrder[0],
    txMocks.idea.findUnique.mock.invocationCallOrder[0],
    txMocks.claudeJob.findFirst.mock.invocationCallOrder[0],
    txMocks.idea.update.mock.invocationCallOrder[0],
    txMocks.ideaLog.create.mock.invocationCallOrder[0],
  ]
  for (const n of order) expect(n).toBeTypeOf('number')
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // Niets buiten de transactie om: geen directe idea-update of jobcheck.
  expect(mockUpdate).not.toHaveBeenCalled()
  expect(mockJobFind).not.toHaveBeenCalled()
})

it('herleest de status onder het slot', async () => {
  mockFind.mockResolvedValue({ id: 'idea-1', status: 'DRAFT' })
  txMocks.idea.findUnique.mockResolvedValue({ status: 'GRILLING' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/GRILLING/)
  expect(txMocks.claudeJob.findFirst).not.toHaveBeenCalled()
  expect(txMocks.idea.update).not.toHaveBeenCalled()
  expect(txMocks.ideaLog.create).not.toHaveBeenCalled()
})

it('tweede afsluiting is een no-op', async () => {
  mockFind.mockResolvedValue({ id: 'idea-1', code: 'IDEA-042', status: 'PLANNED' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toEqual({ id: 'idea-1', code: 'IDEA-042', status: 'PLANNED' })
  expect(mockTransaction).not.toHaveBeenCalled()
  expect(mockUpdate).not.toHaveBeenCalled()
  expect(txMocks.idea.update).not.toHaveBeenCalled()
  expect(txMocks.ideaLog.create).not.toHaveBeenCalled()
  expect(mockChatMessage).not.toHaveBeenCalled()
})

it('herlezing vindt het idee niet meer', async () => {
  txMocks.idea.findUnique.mockResolvedValue(null)
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toContain('Idea not found')
  expect(txMocks.claudeJob.findFirst).not.toHaveBeenCalled()
  expect(txMocks.idea.update).not.toHaveBeenCalled()
  expect(txMocks.ideaLog.create).not.toHaveBeenCalled()
})

it('weigert PLANNED vanuit SPEC_REVIEWING', async () => {
  mockFind.mockResolvedValue({ id: 'idea-1', code: 'IDEA-042', status: 'SPEC_REVIEWING' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/SPEC_REVIEWING/)
  expect(mockTransaction).not.toHaveBeenCalled()
  expect(mockUpdate).not.toHaveBeenCalled()
  expect(txMocks.idea.update).not.toHaveBeenCalled()
})

it('status-only schrijft geen DOC_UPDATE-kanaalbericht', async () => {
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', status: 'PLANNED' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ status: 'PLANNED' })
  expect(mockChatMessage).not.toHaveBeenCalled()
})

it('weigert een andere status dan PLANNED', async () => {
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    title: 'T',
    status: 'DRAFT',
  } as unknown as Parameters<typeof handleUpdateIdea>[0])
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/VALIDATION_ERROR/)
  expect(toolText(res)).toMatch(/status/)
  expect(mockUpdate).not.toHaveBeenCalled()
  expect(mockTransaction).not.toHaveBeenCalled()
})

it('sluit af met een nieuwe titel: titel in de transactie-update, content-policy gecheckt, DOC_UPDATE na commit', async () => {
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    title: 'Nieuwe titel',
    status: 'PLANNED',
  })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toEqual({ id: 'idea-1', code: 'IDEA-042', status: 'PLANNED' })
  expect(mockProduct).toHaveBeenCalledWith({
    where: { id: 'prod-1' },
    select: { content_policy: true },
  })
  expect(txMocks.idea.update).toHaveBeenCalledWith({
    where: { id: 'idea-1' },
    data: { status: 'PLANNED', title: 'Nieuwe titel' },
    select: { id: true, code: true, status: true },
  })
  expect(mockUpdate).not.toHaveBeenCalled()
  expect(mockChatMessage).toHaveBeenCalledTimes(1)
  expect(mockChatMessage).toHaveBeenCalledWith({
    data: {
      idea_id: 'idea-1',
      role: 'SYSTEM',
      kind: 'DOC_UPDATE',
      content: 'Beschrijving bijgewerkt door de agent',
      metadata: { fields: ['title'] },
    },
  })
  expect(mockChatMessage.mock.invocationCallOrder[0]).toBeGreaterThan(
    txMocks.ideaLog.create.mock.invocationCallOrder[0],
  )
})

it('sluit niet af als de content-policy de nieuwe titel weigert', async () => {
  mockProduct.mockResolvedValue({
    content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] },
  })
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    title: 'Voeg een bsn-veld toe',
    status: 'PLANNED',
  })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/AVG.*bsn/)
  expect(mockTransaction).not.toHaveBeenCalled()
  expect(txMocks.idea.update).not.toHaveBeenCalled()
  expect(mockChatMessage).not.toHaveBeenCalled()
})
