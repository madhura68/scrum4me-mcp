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
