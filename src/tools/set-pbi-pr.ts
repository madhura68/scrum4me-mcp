import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { ForgejoError, parseForgejoPrUrl } from '../git/forgejo-rest.js'

export const inputSchema = z.object({
  pbi_id: z.string().min(1),
  pr_url: z.string().refine(
    (v) => {
      try {
        parseForgejoPrUrl(v)
        return true
      } catch {
        return false
      }
    },
    {
      message:
        'pr_url must be a Forgejo /pulls/N URL (GitHub URLs not accepted — Forgejo is leidend)',
    },
  ),
})

export async function handleSetPbiPr({ pbi_id, pr_url }: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()

    // Re-parse om typed LEGACY_GITHUB_URL te onderscheiden van algemene parse-errors.
    // Schema-validatie hierboven heeft al gefilterd op valid Forgejo-URLs, dus
    // dit pad raken we alleen wanneer iemand het schema omzeilt (intern gebruik).
    try {
      parseForgejoPrUrl(pr_url)
    } catch (err) {
      if (err instanceof ForgejoError && err.code === 'LEGACY_GITHUB_URL') {
        return toolError(`LEGACY_GITHUB_URL: ${err.message}`)
      }
      return toolError(`Invalid Forgejo PR URL: ${(err as Error).message}`)
    }

    const pbi = await prisma.pbi.findUnique({
      where: { id: pbi_id },
      select: { product_id: true },
    })
    if (!pbi || !(await userCanAccessProduct(pbi.product_id, auth.userId))) {
      return toolError(`PBI ${pbi_id} not found or not accessible`)
    }

    await prisma.pbi.update({
      where: { id: pbi_id },
      data: { pr_url, pr_merged_at: null },
    })

    return toolJson({ ok: true, pbi_id, pr_url })
  })
}

export function registerSetPbiPrTool(server: McpServer) {
  server.registerTool(
    'set_pbi_pr',
    {
      title: 'Set PBI PR URL',
      description:
        'Write pr_url on a PBI and clear pr_merged_at. Forgejo is leidend: alleen /pulls/N URLs op een geconfigureerde Forgejo-host worden geaccepteerd. github.com URLs worden geweigerd (gebruik de Forgejo-mirror). Idempotent: re-calling overwrites pr_url en reset pr_merged_at naar null. Forbidden voor demo accounts.',
      inputSchema,
    },
    handleSetPbiPr,
  )
}
