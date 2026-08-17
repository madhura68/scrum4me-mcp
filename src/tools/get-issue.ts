// Issue-tracker (spec §8): het volledige issue inclusief onderzoek, oplossing
// en logboek — wat een agent nodig heeft om verder te werken aan een probleem
// dat iemand anders heeft geregistreerd.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import {
  issueStatusToApi, issueSeverityToApi, issueResolutionToApi,
} from '@shared/issue-status.js'

const inputSchema = z.object({
  issue_id: z.string().min(1),
})

export async function handleGetIssue(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await getAuth()

    const issue = await prisma.issue.findUnique({
      where: { id: parsed.issue_id },
      include: {
        product: { select: { id: true, name: true, kind: true } },
        logs: { orderBy: { created_at: 'desc' }, take: 50 },
        linked_pbi: { select: { id: true, code: true, title: true } },
        linked_idea: { select: { id: true, code: true, title: true } },
      },
    })
    if (!issue || !(await userCanAccessProduct(issue.product_id, auth.userId))) {
      return toolError(`Issue ${parsed.issue_id} not found or not accessible`)
    }

    return toolJson({
      id: issue.id,
      code: issue.code,
      title: issue.title,
      description: issue.description,
      research_md: issue.research_md,
      resolution_md: issue.resolution_md,
      status: issueStatusToApi(issue.status),
      resolution: issue.resolution ? issueResolutionToApi(issue.resolution) : null,
      severity: issueSeverityToApi(issue.severity),
      reported_by: issue.reported_by,
      fingerprint: issue.fingerprint,
      occurrence_count: issue.occurrence_count,
      last_seen_at: issue.last_seen_at,
      created_at: issue.created_at,
      closed_at: issue.closed_at,
      archived: issue.archived,
      product: issue.product,
      linked_pbi: issue.linked_pbi,
      linked_idea: issue.linked_idea,
      forgejo_repo: issue.forgejo_repo,
      forgejo_number: issue.forgejo_number,
      forgejo_dirty: issue.forgejo_dirty,
      forgejo_error: issue.forgejo_error,
      logs: issue.logs.map((l) => ({
        type: l.type, content: l.content, metadata: l.metadata, created_at: l.created_at,
      })),
    })
  })
}

export function registerGetIssueTool(server: McpServer) {
  server.registerTool(
    'get_issue',
    {
      title: 'Get issue',
      description: 'Fetch one issue with its research, resolution, links and the last 50 log entries.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => handleGetIssue(input),
  )
}
