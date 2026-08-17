// Issue-tracker (spec §8): het onderzoek en de oplossing bijwerken vanuit een
// agent. Anders dan de web-action APPENDT deze tool aan research_md/
// resolution_md: meerdere agents schrijven na elkaar aan hetzelfde issue, en
// overschrijven zou het spoor wissen.
//
// De afzender komt uit `authored_by` of anders de token-username — nooit uit
// Issue.reported_by. Dat veld is de mélder van het issue; in de primaire flow
// (max2 meldt, een andere agent onderzoekt) zou elke onderzoeksregel dan de
// verkeerde naam dragen, team-zichtbaar én gespiegeld naar Forgejo.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { syncIssueToForgejo } from '../lib/issue-sync.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import {
  canTransitionIssue, issueStatusFromApi, issueSeverityFromApi, issueResolutionFromApi,
  type IssueStatusDb,
} from '@shared/issue-status.js'

const inputSchema = z.object({
  issue_id: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  severity: z.string().optional(),
  status: z.string().optional(),
  resolution: z.string().optional(),
  append_research: z.string().trim().min(1).max(100000).optional(),
  append_resolution: z.string().trim().min(1).max(100000).optional(),
  // trim().min(1) maakt whitespace-only een validatiefout: die zou anders via
  // `??` heen glippen en een scheider zónder afzender opleveren.
  authored_by: z.string().trim().min(1).max(60).optional(),
  link_pbi_id: z.string().nullable().optional(),
  link_idea_id: z.string().nullable().optional(),
})

function appendSection(existing: string | null, addition: string, author: string): string {
  const separator = `---\n*${new Date().toISOString()} — ${author}*\n\n`
  return existing ? `${existing}\n\n${separator}${addition}` : `${separator}${addition}`
}

export async function handleUpdateIssue(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await requireWriteAccess()

    const issue = await prisma.issue.findUnique({
      where: { id: parsed.issue_id },
      select: {
        id: true, product_id: true, status: true, resolution: true,
        research_md: true, resolution_md: true,
      },
    })
    if (!issue || !(await userCanAccessProduct(issue.product_id, auth.userId))) {
      return toolError(`Issue ${parsed.issue_id} not found or not accessible`)
    }

    const author = parsed.authored_by ?? auth.username
    const data: Record<string, unknown> = {}
    const logs: { type: string; content: string }[] = []

    if (parsed.title !== undefined) data.title = parsed.title
    if (parsed.severity !== undefined) {
      const severity = issueSeverityFromApi(parsed.severity)
      if (!severity) return toolError(`Onbekende severity: ${parsed.severity}`)
      data.severity = severity
    }
    if (parsed.append_research !== undefined) {
      data.research_md = appendSection(issue.research_md, parsed.append_research, author)
      logs.push({ type: 'RESEARCH', content: `Onderzoek aangevuld door ${author}` })
    }
    if (parsed.append_resolution !== undefined) {
      data.resolution_md = appendSection(issue.resolution_md, parsed.append_resolution, author)
      logs.push({ type: 'RESOLUTION', content: `Oplossing aangevuld door ${author}` })
    }

    if (parsed.status !== undefined) {
      const to = issueStatusFromApi(parsed.status)
      if (!to) return toolError(`Onbekende status: ${parsed.status}`)
      if (!canTransitionIssue(issue.status as IssueStatusDb, to)) {
        return toolError(`Transitie ${issue.status} → ${to} is niet toegestaan`)
      }
      if (to === 'CLOSED') {
        const resolution = parsed.resolution ? issueResolutionFromApi(parsed.resolution) : null
        if (!resolution) return toolError('Sluiten vereist een resolution')
        data.status = 'CLOSED'
        data.resolution = resolution
        data.closed_at = new Date()
        logs.push({ type: 'STATUS_CHANGE', content: `${issue.status} → CLOSED (${resolution})` })
      } else if (issue.status === 'CLOSED') {
        data.status = to
        data.resolution = null
        data.closed_at = null
        logs.push({ type: 'STATUS_CHANGE', content: `CLOSED → ${to}` })
        logs.push({ type: 'REOPENED', content: `Heropend door ${author} (was ${issue.resolution})` })
      } else {
        data.status = to
        logs.push({ type: 'STATUS_CHANGE', content: `${issue.status} → ${to}` })
      }
    } else if (parsed.resolution !== undefined) {
      return toolError('Resolution kan alleen samen met status=closed')
    }

    const result = await prisma.$transaction(async (tx) => {
      if (parsed.link_pbi_id !== undefined && parsed.link_pbi_id !== null) {
        const pbi = await tx.pbi.findUnique({
          where: { id: parsed.link_pbi_id },
          select: { product_id: true },
        })
        if (!pbi || pbi.product_id !== issue.product_id) {
          return { ok: false, error: 'PBI hoort niet bij het product van dit issue' } as const
        }
        data.linked_pbi_id = parsed.link_pbi_id
      } else if (parsed.link_pbi_id === null) {
        data.linked_pbi_id = null
      }
      const linkIdeaId = parsed.link_idea_id
      if (linkIdeaId !== undefined && linkIdeaId !== null) {
        const idea = await tx.idea.findUnique({
          where: { id: linkIdeaId },
          select: { product_id: true },
        })
        if (!idea) return { ok: false, error: 'Idea niet gevonden' } as const
        if (idea.product_id !== issue.product_id) {
          const junction = await tx.ideaProduct.findUnique({
            where: { idea_id_product_id: { idea_id: linkIdeaId, product_id: issue.product_id } },
          })
          if (!junction) return { ok: false, error: 'Idea hoort niet bij het product van dit issue' } as const
        }
        data.linked_idea_id = linkIdeaId
      } else if (parsed.link_idea_id === null) {
        data.linked_idea_id = null
      }

      // Dirty-invariant (spec §6): mutatie ⇒ dirty + seq in dezelfde transactie.
      const updated = await tx.issue.update({
        where: { id: parsed.issue_id },
        data: { ...data, forgejo_dirty: true, forgejo_sync_seq: { increment: 1 } },
        select: { id: true, code: true, status: true, resolution: true },
      })
      for (const log of logs) {
        await tx.issueLog.create({
          data: { issue_id: parsed.issue_id, type: log.type as never, content: log.content },
        })
      }
      return { ok: true, issue: updated } as const
    })

    if (!result.ok) return toolError(result.error)

    void syncIssueToForgejo(parsed.issue_id).catch(() => {})
    return toolJson({ issue: result.issue })
  })
}

export function registerUpdateIssueTool(server: McpServer) {
  server.registerTool(
    'update_issue',
    {
      title: 'Update issue',
      description:
        'Update an issue: append research or resolution (timestamped, attributed to authored_by or the token user), change status/severity, or link a PBI or idea. Closing requires a resolution; a closed issue can only reopen to investigating.',
      inputSchema,
    },
    async (input) => handleUpdateIssue(input),
  )
}
