// M45-2b (Taak 2, deel 2): readHarnessChoice leest de productkeuze voor (product, jobsoort). Eén lezing voor de claim
// (het plafond) en de enqueue (de configuratie, Taak 4, met een transactieclient). Aanroepers krijgen alleen
// strings, en een leesfout gaat omhoog: een fout is nooit "geen rij", dus nooit de standaard.
import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { readHarnessChoice } from '../../src/lib/harness-choice.js'

type Db = Parameters<typeof readHarnessChoice>[0]

function dbReturning(findUnique: ReturnType<typeof vi.fn>): Db {
  return { productHarnessChoice: { findUnique } } as unknown as Db
}

describe('readHarnessChoice', () => {
  it('zoekt de rij op product én jobsoort', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)

    await readHarnessChoice(dbReturning(findUnique), 'prod-1', 'TASK_IMPLEMENTATION')

    expect(findUnique).toHaveBeenCalledTimes(1)
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { product_id_kind: { product_id: 'prod-1', kind: 'TASK_IMPLEMENTATION' } } }),
    )
  })

  it('geeft null als er geen rij is', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)

    await expect(readHarnessChoice(dbReturning(findUnique), 'prod-1', 'IDEA_CHAT')).resolves.toBeNull()
  })

  it('geeft de configuratienaam en het plafond als strings', async () => {
    const findUnique = vi.fn().mockResolvedValue({ configuration: 'gsq-lokaal', max_cost_usd: new Prisma.Decimal('0.2000') })

    const choice = await readHarnessChoice(dbReturning(findUnique), 'prod-1', 'IDEA_CHAT')

    expect(choice).toEqual({ configuration: 'gsq-lokaal', max_cost_usd: '0.2' })
    expect(typeof choice?.max_cost_usd).toBe('string')
  })

  // Decimal(10,4): de opgeslagen waarde heeft vier decimalen; de string is de gewone, korte notatie zonder
  // afsluitende nullen en zonder exponent, ook aan de randen van het bereik.
  it.each([
    ['0.0500', '0.05'],
    ['0.5000', '0.5'],
    ['0.0001', '0.0001'],
    ['12.3456', '12.3456'],
    ['100.0000', '100'],
    ['999999.9999', '999999.9999'],
  ])('zet de Decimal %s om naar de string %s', async (stored, expected) => {
    const findUnique = vi.fn().mockResolvedValue({ configuration: 'gsq-lokaal', max_cost_usd: new Prisma.Decimal(stored) })

    const choice = await readHarnessChoice(dbReturning(findUnique), 'prod-1', 'TASK_IMPLEMENTATION')

    expect(choice?.max_cost_usd).toBe(expected)
  })

  it('laat een leesfout door: nooit null en nooit een standaard', async () => {
    const failure = new Error('connection terminated unexpectedly')
    const findUnique = vi.fn().mockRejectedValue(failure)

    await expect(readHarnessChoice(dbReturning(findUnique), 'prod-1', 'IDEA_CHAT')).rejects.toBe(failure)
  })

  // Taak 4 (enqueue) leest dezelfde keuze binnen een transactie: een transactieclient moet als `db` passen.
  // Dit is een controle van het type; `npm run typecheck:tests` faalt als de signatuur dat niet meer toelaat.
  it('accepteert ook een transactieclient als db (het type)', () => {
    const accepts = (tx: Prisma.TransactionClient): Db => tx
    expect(typeof accepts).toBe('function')
  })
})
