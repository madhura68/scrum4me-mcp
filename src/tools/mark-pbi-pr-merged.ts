import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  pbi_id: z.string().min(1),
})

export async function handleMarkPbiPrMerged({ pbi_id }: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()

    const pbi = await prisma.pbi.findUnique({
      where: { id: pbi_id },
      select: { product_id: true, pr_url: true },
    })
    if (!pbi || !(await userCanAccessProduct(pbi.product_id, auth.userId))) {
      return toolError(`PBI ${pbi_id} not found or not accessible`)
    }
    if (!pbi.pr_url) {
      return toolError(`PBI ${pbi_id} heeft geen gekoppelde PR`)
    }

    const updated = await prisma.pbi.update({
      where: { id: pbi_id },
      data: { pr_merged_at: new Date() },
      select: { id: true, pr_url: true, pr_merged_at: true },
    })

    return toolJson({ ok: true, pbi_id, pr_url: updated.pr_url, pr_merged_at: updated.pr_merged_at })
  })
}

export function registerMarkPbiPrMergedTool(server: McpServer) {
  server.registerTool(
    'mark_pbi_pr_merged',
    {
      title: 'Mark PBI PR Merged',
      description:
        'Set pr_merged_at = now() on a PBI, signalling the PR has been merged. Requires pr_url to already be set. Idempotent: re-calling overwrites the timestamp. Forbidden for demo accounts.',
      inputSchema,
    },
    handleMarkPbiPrMerged,
  )
}
