import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: { $executeRaw: vi.fn() } }))

import { prisma } from '../src/prisma.js'
import { QUEUE_CHANNEL, emitQueueNotifyBestEffort, envelopeOf } from '../src/queue/notify.js'

const mockPrisma = prisma as unknown as { $executeRaw: ReturnType<typeof vi.fn> }

const row = {
  id: 'id-1',
  type: 'task',
  from_server: 'mac',
  from_model: 'claude',
  to_server: 'scrum4me-server',
  to_model: 'claude',
  in_reply_to: null,
  status: 'pending',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$executeRaw.mockResolvedValue(1)
})

describe('envelopeOf — byte-compatibel met s4m-queue/src/db.ts', () => {
  it('emit exact de CLI-veldenset in dezelfde volgorde', () => {
    expect(Object.keys(envelopeOf(row, null))).toEqual([
      'id', 'type', 'from_server', 'from_model', 'to_server', 'to_model',
      'in_reply_to', 'status', 'previous_status',
    ])
  })

  it('draagt previous_status mee', () => {
    expect(envelopeOf({ ...row, status: 'claimed' }, 'pending').previous_status).toBe('pending')
  })

  it('gebruikt het CLI-kanaal agent_queue', () => {
    expect(QUEUE_CHANNEL).toBe('agent_queue')
  })
})

describe('emitQueueNotifyBestEffort', () => {
  it('stuurt pg_notify via prisma', async () => {
    await emitQueueNotifyBestEffort(envelopeOf(row, null))
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('slikt DB-fouten (best-effort, nooit tool-falen — §7)', async () => {
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('down'))
    await expect(emitQueueNotifyBestEffort(envelopeOf(row, null))).resolves.toBeUndefined()
  })
})

describe('de payload die daadwerkelijk verzonden wordt', () => {
  // De vijf tests hierboven kijken naar het object vóór serialisatie en naar
  // óf $executeRaw is aangeroepen — niet naar wát er uit gaat. Dat liet een
  // echte wire-breuk door: previousStatus ?? undefined in plaats van ?? null
  // laat JSON.stringify de sleutel volledig weglaten, terwijl alle vijf groen
  // bleven. Deze drie kijken naar de argumenten die de mock bereiken.
  //
  // Vorm van een tagged template: fn`..${a}..${b}..` roept de mock aan als
  // (stringsArray, a, b) — dus calls[0][1] is het kanaal, calls[0][2] de JSON.

  it('stuurt de volledige envelope, inclusief null-velden', async () => {
    await emitQueueNotifyBestEffort(envelopeOf(row, null))
    const payload = mockPrisma.$executeRaw.mock.calls[0][2] as string
    // Bewust een hardgecodeerd literal en niet envelopeOf(...) opnieuw
    // aanroepen: anders deelt de assertie een eventuele bug met de code die
    // hij moet controleren.
    expect(JSON.parse(payload)).toStrictEqual({
      id: 'id-1',
      type: 'task',
      from_server: 'mac',
      from_model: 'claude',
      to_server: 'scrum4me-server',
      to_model: 'claude',
      in_reply_to: null,
      status: 'pending',
      previous_status: null,
    })
  })

  it('verzendt op het kanaal dat QUEUE_CHANNEL exporteert', async () => {
    // De kanaal-test hierboven controleert de export in isolatie. Een
    // aanroepsite die een ander literal hardcodeert komt daar ongestraft
    // doorheen; deze assertie koppelt de twee aan elkaar.
    await emitQueueNotifyBestEffort(envelopeOf(row, null))
    expect(mockPrisma.$executeRaw.mock.calls[0][1]).toBe(QUEUE_CHANNEL)
  })

  it('serialiseert null-velden als JSON null, niet als weggelaten sleutel', async () => {
    await emitQueueNotifyBestEffort(envelopeOf(row, null))
    const payload = mockPrisma.$executeRaw.mock.calls[0][2] as string
    expect(payload).toContain('"in_reply_to":null')
    expect(payload).toContain('"previous_status":null')
  })
})
