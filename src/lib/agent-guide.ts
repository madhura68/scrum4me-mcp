import { ProductDocFolder } from '@prisma/client'
import { prisma } from '../prisma.js'
import { AGENT_GUIDE_DEFAULT } from './agent-guide-default.js'
import { parseProductDocMd } from './product-doc-parser.js'
import { agentContext, type AgentContext, type AgentInput } from './agent-context.js'

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
  agent_context: AgentContext
}

export async function resolveAgentGuide(
  product: AgentGuideProduct,
  agent?: AgentInput,
): Promise<AgentGuideResult> {
  const model = agent?.model_id
    ? await prisma.agentModel.findUnique({
        where: { runtime_model_id: { runtime: agent.runtime, model_id: agent.model_id } },
        select: { id: true, display_name: true },
      })
    : null
  const appliedProfiles: string[] = []
  let guide_md = AGENT_GUIDE_DEFAULT
  let override:
    | { slug: string; status: string; content_md: string; updated_at: Date }
    | null = null

  if (product.enabled_doc_folders.includes(ProductDocFolder.MANUAL)) {
    const supplements = [
      ...(agent ? [{ slug: `agent-guide-runtime-${agent.runtime.toLowerCase()}`, label: `Runtime-aanvullingen — ${agent.runtime}` }] : []),
      ...(model ? [{ slug: `agent-guide-model-${model.id}`, label: `Model-aanvullingen — ${model.display_name}` }] : []),
    ]
    for (const profile of supplements) {
      const doc = await prisma.productDoc.findFirst({
        where: { product_id: product.id, folder: ProductDocFolder.MANUAL, slug: profile.slug, status: 'active' },
        select: { slug: true, content_md: true },
      })
      if (!doc) continue
      const parsed = parseProductDocMd(doc.content_md)
      const body = parsed.ok ? parsed.body.trim() : doc.content_md.trim()
      guide_md += `\n\n---\n\n## ${profile.label} (${doc.slug})\n\n${body}`
      appliedProfiles.push(doc.slug)
    }
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

  if (override) {
    const label = product.code ?? product.name
    const parsed = parseProductDocMd(override.content_md)
    const overrideBody = parsed.ok ? parsed.body.trim() : override.content_md.trim()
    guide_md += `\n\n---\n\n## Product-specifieke aanvullingen — ${label}\n\n${overrideBody}`
    appliedProfiles.push(override.slug)
  }

  if (guide_md.length > AGENT_GUIDE_MAX_CHARS) {
    throw new AgentGuideTooLargeError(guide_md.length)
  }

  return {
    guide_md,
    agent_context: agentContext(agent, model?.display_name ?? null, appliedProfiles),
    has_product_override: override !== null,
    product_doc: override
      ? { slug: override.slug, status: override.status, updated_at: override.updated_at }
      : null,
  }
}
