// ISS-17: koppel een idee aan de PBI of sprint die een ceremonie ervan maakt.
//
// De koppeling vult ideas.pbi_id / ideas.build_sprint_id alleen als die leeg is
// (besluit PO: nooit overschrijven). Validatie gebeurt vóór de mutatie op de
// root-client; de koppeling zelf draait in de transactie van de create.

import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

export type IdeaLinkField = 'pbi_id' | 'build_sprint_id'

export interface IdeaLinkResult {
  idea_id: string
  field: IdeaLinkField
  outcome: 'set' | 'skipped_existing'
}

/** Geeft een foutmelding terug, of null als het idee aan dit product gekoppeld mag worden. */
export async function loadLinkableIdea(
  ideaId: string,
  productId: string,
  userId: string,
): Promise<string | null> {
  const idea = await prisma.idea.findFirst({
    where: { id: ideaId, user_id: userId },
    select: { product_id: true },
  })
  // Zelfde melding voor een vreemd en een onbestaand idee: geen bestaan lekken.
  if (!idea) return `Idea ${ideaId} not found or not accessible`
  if (idea.product_id === productId) return null
  const junction = await prisma.ideaProduct.findUnique({
    where: { idea_id_product_id: { idea_id: ideaId, product_id: productId } },
    select: { id: true },
  })
  if (!junction) {
    return `Idea ${ideaId} does not belong to product ${productId} (neither primary nor secondary)`
  }
  return null
}

export async function linkIdeaIfEmpty(
  tx: Prisma.TransactionClient,
  ideaId: string,
  field: IdeaLinkField,
  value: string,
): Promise<IdeaLinkResult> {
  const { count } = field === 'pbi_id'
    ? await tx.idea.updateMany({ where: { id: ideaId, pbi_id: null }, data: { pbi_id: value } })
    : await tx.idea.updateMany({ where: { id: ideaId, build_sprint_id: null }, data: { build_sprint_id: value } })
  return { idea_id: ideaId, field, outcome: count > 0 ? 'set' : 'skipped_existing' }
}
