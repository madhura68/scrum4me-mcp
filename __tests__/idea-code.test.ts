import { it, expect, vi } from 'vitest'
import { formatIdeaCode, nextIdeaCode } from '../src/lib/idea-code.js'

function txMock(counter: number, maxExisting: number | null) {
  return {
    user: { update: vi.fn().mockResolvedValue({ idea_code_counter: counter }) },
    $queryRaw: vi.fn().mockResolvedValue([{ max_n: maxExisting }]),
  }
}

it('formatteert met pad 3 en groeit voorbij 999', () => {
  expect(formatIdeaCode(7)).toBe('IDEA-007')
  expect(formatIdeaCode(1234)).toBe('IDEA-1234')
})

it('gebruikt de counter als die voorloopt', async () => {
  const tx = txMock(12, 5)
  await expect(nextIdeaCode('u1', tx as never)).resolves.toBe('IDEA-012')
})

it('herstelt drift: max bestaande code + 1 wint en counter wordt bijgewerkt', async () => {
  const tx = txMock(3, 41)
  await expect(nextIdeaCode('u1', tx as never)).resolves.toBe('IDEA-042')
  expect(tx.user.update).toHaveBeenCalledTimes(2)
})
