import { ProductDocFolder } from '@prisma/client'
import { prisma } from '../prisma.js'
import { AGENT_GUIDE_DEFAULT } from './agent-guide-default.js'

export const AGENT_GUIDE_MAX_CHARS = 16_000

export class AgentGuideTooLargeError extends Error {
  constructor(public readonly chars: number) {
    super(
      `AGENT_GUIDE_TOO_LARGE: merged guide is ${chars} chars (max ${AGENT_GUIDE_MAX_CHARS})`,
    )
    this.name = 'AgentGuideTooLargeError'
  }
}

export type AgentGuideProduct = {
  id: string
  code: string | null
  name: string
  enabled_doc_folders: ProductDocFolder[]
}

export type AgentGuideResult = {
  guide_md: string
  has_product_override: boolean
  product_doc: { slug: string; status: string; updated_at: Date } | null
}

export async function resolveAgentGuide(
  product: AgentGuideProduct,
): Promise<AgentGuideResult> {
  let override:
    | { slug: string; status: string; content_md: string; updated_at: Date }
    | null = null

  if (product.enabled_doc_folders.includes(ProductDocFolder.MANUAL)) {
    override = await prisma.productDoc.findFirst({
      where: {
        product_id: product.id,
        folder: ProductDocFolder.MANUAL,
        slug: 'agent-guide',
        status: 'active',
      },
      select: { slug: true, status: true, content_md: true, updated_at: true },
    })
  }

  let guide_md = AGENT_GUIDE_DEFAULT
  if (override) {
    const label = product.code ?? product.name
    guide_md = `${AGENT_GUIDE_DEFAULT}\n\n---\n\n## Product-specifieke aanvullingen — ${label}\n\n${override.content_md}`
  }

  if (guide_md.length > AGENT_GUIDE_MAX_CHARS) {
    throw new AgentGuideTooLargeError(guide_md.length)
  }

  return {
    guide_md,
    has_product_override: override !== null,
    product_doc: override
      ? { slug: override.slug, status: override.status, updated_at: override.updated_at }
      : null,
  }
}
