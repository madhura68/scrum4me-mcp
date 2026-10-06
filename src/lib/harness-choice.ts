// De productkeuze voor een HARNESS-job (M45, spec §4): welke configuratie en welk kostenplafond een product voor een
// jobsoort heeft gekozen. Eén lezing voor de claim (het plafond, getFullJobContext) en de enqueue (de configuratie,
// met een transactieclient). Prisma-vrij naar buiten: bedragen zijn decimale strings, nooit een number of een Decimal.
import type { prisma } from '../prisma.js'
import type { HarnessJobKind } from '@shared/harness-config.js'

/**
 * De productkeuze voor (product, jobsoort), of null als er geen rij is. Leesfouten gaan omhoog: een fout is nooit
 * "geen rij", dus nooit de standaard van de jobsoort (spec §5.7, geen stille terugval).
 *
 * `max_cost_usd` is in de database een Decimal(10,4); de Prisma-Decimal gaat met `toString()` naar de gewone,
 * korte decimale notatie ('0.2000' wordt '0.2'). Binnen Decimal(10,4) geeft toString() nooit een exponent.
 */
export async function readHarnessChoice(
  db: Pick<typeof prisma, 'productHarnessChoice'>,
  productId: string,
  kind: HarnessJobKind,
): Promise<{ configuration: string; max_cost_usd: string } | null> {
  const row = await db.productHarnessChoice.findUnique({
    where: { product_id_kind: { product_id: productId, kind } },
    select: { configuration: true, max_cost_usd: true },
  })
  if (!row) return null
  return { configuration: row.configuration, max_cost_usd: row.max_cost_usd.toString() }
}
