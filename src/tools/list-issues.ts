// Issue-tracker (spec §8): compacte lijst per product of systeem, nieuwste
// waarneming eerst. Gesloten issues blijven standaard buiten beeld — een agent
// die kijkt of een probleem al bekend is, wil de open verzameling.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import {
  issueStatusToApi, issueSeverityToApi, issueStatusFromApi, issueSeverityFromApi,
} from '@shared/issue-status.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
  status: z.string().optional(),
  severity: z.string().optional(),
  include_closed: z.boolean().optional(),
  include_archived: z.boolean().optional(),
})

export async function handleListIssues(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await getAuth()
    if (!(await userCanAccessProduct(parsed.product_id, auth.userId))) {
      return toolError(`Product ${parsed.product_id} not found or not accessible`)
    }

    let statusFilter
    if (parsed.status) {
      statusFilter = issueStatusFromApi(parsed.status)
      if (!statusFilter) return toolError(`Onbekende status: ${parsed.status}`)
    }
    let severityFilter
    if (parsed.severity) {
      severityFilter = issueSeverityFromApi(parsed.severity)
      if (!severityFilter) return toolError(`Onbekende severity: ${parsed.severity}`)
    }

    const issues = await prisma.issue.findMany({
      where: {
        product_id: parsed.product_id,
        ...(parsed.include_archived ? {} : { archived: false }),
        ...(statusFilter
          ? { status: statusFilter }
          : parsed.include_closed
            ? {}
            : { status: { not: 'CLOSED' } }),
        ...(severityFilter ? { severity: severityFilter } : {}),
      },
      orderBy: { last_seen_at: 'desc' },
      take: 50,
      select: {
        id: true, code: true, title: true, status: true, severity: true,
        occurrence_count: true, last_seen_at: true, fingerprint: true, forgejo_number: true,
      },
    })

    return toolJson(
      issues.map((i) => ({
        ...i,
        status: issueStatusToApi(i.status),
        severity: issueSeverityToApi(i.severity),
      })),
    )
  })
}

export function registerListIssuesTool(server: McpServer) {
  server.registerTool(
    'list_issues',
    {
      title: 'List issues',
      description:
        'List issues of a product or system (max 50, most recently seen first). Closed issues are excluded unless include_closed is set.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => handleListIssues(input),
  )
}
