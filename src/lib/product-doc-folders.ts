// Folder-mapping voor ProductDoc. Gespiegeld van Scrum4Me's
// lib/product-doc-folder.ts + lib/schemas/product-doc.ts.
//
// 9 folders (incl GRILLS — PBI-102 toevoeging in scrum4me-mcp's prisma).
// Houd de array in volgorde voor stabiele list-output.

import type { ProductDocFolder } from '@prisma/client'

export const PRODUCT_DOC_FOLDERS_API = [
  'adr',
  'architecture',
  'grills',
  'patterns',
  'plans',
  'runbooks',
  'specs',
  'manual',
  'api',
] as const

export type ProductDocFolderApi = (typeof PRODUCT_DOC_FOLDERS_API)[number]

const FOLDER_DB_TO_API: Record<ProductDocFolder, ProductDocFolderApi> = {
  ADR: 'adr',
  ARCHITECTURE: 'architecture',
  GRILLS: 'grills',
  PATTERNS: 'patterns',
  PLANS: 'plans',
  RUNBOOKS: 'runbooks',
  SPECS: 'specs',
  MANUAL: 'manual',
  API: 'api',
}

const FOLDER_API_TO_DB: Record<ProductDocFolderApi, ProductDocFolder> = {
  adr: 'ADR',
  architecture: 'ARCHITECTURE',
  grills: 'GRILLS',
  patterns: 'PATTERNS',
  plans: 'PLANS',
  runbooks: 'RUNBOOKS',
  specs: 'SPECS',
  manual: 'MANUAL',
  api: 'API',
}

export function productDocFolderToApi(f: ProductDocFolder): ProductDocFolderApi {
  return FOLDER_DB_TO_API[f]
}

export function productDocFolderFromApi(s: string): ProductDocFolder | null {
  const lower = s.toLowerCase()
  return (FOLDER_API_TO_DB as Record<string, ProductDocFolder>)[lower] ?? null
}

// 1-regel "wat hoort hier" per folder. Gespiegeld van Scrum4Me's canonieke
// taxonomie — houd in sync met lib/product-doc-folder.ts daar.
export const PRODUCT_DOC_FOLDER_DESCRIPTIONS: Record<ProductDocFolderApi, string> = {
  adr: 'Architecture Decision Records: vastgelegde keuzes met context, alternatieven en consequenties.',
  architecture: 'Systeem- en service-ontwerp: componenten, grenzen, data-flow, integraties.',
  grills: 'Resultaten van idee-grill-sessies: probleemverkenning, scope-afbakening, beslissingen.',
  patterns: "Herbruikbare code- en gebruikspatronen, conventies en do/don't.",
  plans: 'Implementatieplannen per PBI/idee: stories en taken.',
  runbooks: 'Operationele procedures: deploy, incident-respons, onderhoud.',
  specs: 'Functionele en technische specificaties van features.',
  manual: 'Eindgebruikers- en producthandleiding.',
  api: "API-referentie: endpoints, schema's, contracten.",
}
