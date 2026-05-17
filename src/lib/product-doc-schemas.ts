// PBI-102 (T-1123): DRY-mirror van Scrum4Me's frontmatter-schema, minimaal
// gehouden voor wat de MCP write-laag nodig heeft. Wijzig zowel hier als in
// ~/Development/Scrum4Me/lib/schemas/product-doc.ts bij elke aanpassing.

import { z } from 'zod'

export const PRODUCT_DOC_STATUSES = [
  'draft',
  'active',
  'deprecated',
  'archived',
] as const

export const productDocFrontmatterSchema = z.object({
  title: z.string().min(1, 'Titel is verplicht').max(200, 'Maximaal 200 tekens'),
  status: z.enum(PRODUCT_DOC_STATUSES),
  audience: z.union([z.string(), z.array(z.string())]).optional(),
  applies_to: z.union([z.string(), z.array(z.string())]).optional(),
  last_updated: z.string().optional(),
})

export type ProductDocFrontmatter = z.infer<typeof productDocFrontmatterSchema>
