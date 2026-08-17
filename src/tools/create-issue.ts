// Issue-tracker (spec §7/§8): issues registreren met fingerprint-dedup en
// heropenen-als-regressie. reported_by is een expliciet inputveld — de shared
// toolset heeft geen caller-host-identiteit. Geen handmatige pg_notify: de
// issues-tabel heeft een DB-trigger.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { nextIssueCode } from '../lib/issue-code.js'
import { syncIssueToForgejo } from '../lib/issue-sync.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { parseContentPolicy, checkContentPolicy, ContentPolicyError } from '@shared/content-policy.js'
import { issueSeverityFromApi, REOPENABLE_RESOLUTIONS } from '@shared/issue-status.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20000),
  severity: z.string().optional(),
  fingerprint: z.string().trim().min(1).max(200).optional(),
  reported_by: z.string().trim().max(60).optional(),
})

type CreateResult = {
  issue: { id: string; code: string; status: string; occurrence_count: number }
  created: boolean
  deduped_into?: string
}

async function occurrencePath(existingId: string, description: string, reportedBy?: string): Promise<CreateResult> {
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.issue.update({
      where: { id: existingId },
      data: {
        occurrence_count: { increment: 1 },
        last_seen_at: new Date(),
        forgejo_dirty: true,
        forgejo_sync_seq: { increment: 1 },
      },
      select: { id: true, code: true, status: true, occurrence_count: true },
    })
    await tx.issueLog.create({
      data: {
        issue_id: existingId,
        type: 'OCCURRENCE',
        content: description,
        metadata: reportedBy ? { reported_by: reportedBy } : undefined,
      },
    })
    return u
  })
  return { issue: updated, created: false, deduped_into: existingId }
}

export async function handleCreateIssue(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await requireWriteAccess()
    if (!(await userCanAccessProduct(parsed.product_id, auth.userId))) {
      return toolError(`Product ${parsed.product_id} not found or not accessible`)
    }

    const product = await prisma.product.findUnique({
      where: { id: parsed.product_id },
      select: { content_policy: true },
    })
    let policy
    try {
      policy = parseContentPolicy(product?.content_policy)
    } catch (err) {
      if (err instanceof ContentPolicyError) {
        return toolError(`Product content_policy is ongeldig geconfigureerd: ${err.message}`)
      }
      throw err
    }
    const verdict = checkContentPolicy(policy, `${parsed.title}\n${parsed.description}`)
    if (!verdict.allowed) return toolError(verdict.reason)

    const severity = parsed.severity ? issueSeverityFromApi(parsed.severity) : null
    if (parsed.severity && !severity) return toolError(`Onbekende severity: ${parsed.severity}`)

    let result: CreateResult

    if (parsed.fingerprint) {
      const open = await prisma.issue.findFirst({
        where: { product_id: parsed.product_id, fingerprint: parsed.fingerprint, status: { not: 'CLOSED' } },
        select: { id: true },
      })
      if (open) {
        result = await occurrencePath(open.id, parsed.description, parsed.reported_by)
        void syncIssueToForgejo(result.issue.id).catch(() => {})
        return toolJson(result)
      }
      const closed = await prisma.issue.findFirst({
        where: { product_id: parsed.product_id, fingerprint: parsed.fingerprint, status: 'CLOSED' },
        orderBy: { closed_at: { sort: 'desc', nulls: 'last' } },
        select: { id: true, resolution: true },
      })
      if (closed) {
        if (closed.resolution && (REOPENABLE_RESOLUTIONS as readonly string[]).includes(closed.resolution)) {
          const reopened = await prisma.$transaction(async (tx) => {
            const u = await tx.issue.update({
              where: { id: closed.id },
              data: {
                status: 'INVESTIGATING', resolution: null, closed_at: null,
                occurrence_count: { increment: 1 }, last_seen_at: new Date(),
                forgejo_dirty: true, forgejo_sync_seq: { increment: 1 },
              },
              select: { id: true, code: true, status: true, occurrence_count: true },
            })
            await tx.issueLog.create({
              data: { issue_id: closed.id, type: 'STATUS_CHANGE', content: 'CLOSED → INVESTIGATING (regressie)' },
            })
            await tx.issueLog.create({
              data: {
                issue_id: closed.id,
                type: 'REOPENED',
                content: `Regressie: ${parsed.description}`,
                metadata: parsed.reported_by ? { reported_by: parsed.reported_by } : undefined,
              },
            })
            return u
          })
          result = { issue: reopened, created: false, deduped_into: closed.id }
          void syncIssueToForgejo(closed.id).catch(() => {})
          return toolJson(result)
        }
        // WONT_FIX / DUPLICATE / INVALID: bewust genegeerd — alleen tellen (spec §7).
        result = await occurrencePath(closed.id, parsed.description, parsed.reported_by)
        void syncIssueToForgejo(result.issue.id).catch(() => {})
        return toolJson(result)
      }
    }

    try {
      const issue = await prisma.$transaction(async (tx) => {
        const code = await nextIssueCode(parsed.product_id, tx)
        return tx.issue.create({
          data: {
            product_id: parsed.product_id,
            user_id: auth.userId,
            code,
            title: parsed.title,
            description: parsed.description,
            ...(severity ? { severity } : {}),
            fingerprint: parsed.fingerprint ?? null,
            reported_by: parsed.reported_by ?? null,
          },
          select: { id: true, code: true, status: true, occurrence_count: true },
        })
      })
      void syncIssueToForgejo(issue.id).catch(() => {})
      return toolJson({ issue, created: true } satisfies CreateResult)
    } catch (err) {
      // Insert-race op issues_open_fingerprint_key (spec §7): verliezer valt
      // éénmalig terug op het occurrence-pad.
      if (parsed.fingerprint && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await prisma.issue.findFirst({
          where: { product_id: parsed.product_id, fingerprint: parsed.fingerprint, status: { not: 'CLOSED' } },
          select: { id: true },
        })
        if (winner) {
          const r = await occurrencePath(winner.id, parsed.description, parsed.reported_by)
          void syncIssueToForgejo(r.issue.id).catch(() => {})
          return toolJson(r)
        }
      }
      throw err
    }
  })
}

export function registerCreateIssueTool(server: McpServer) {
  server.registerTool(
    'create_issue',
    {
      title: 'Create issue',
      description:
        'Register a problem for a product or system (ISS-n, server-side). With a stable fingerprint (<host>:<component>:<kern>) duplicates increment the existing open issue and a FIXED/CANNOT_REPRODUCE regression reopens it. Forbidden for demo accounts.',
      inputSchema,
    },
    async (input) => handleCreateIssue(input),
  )
}
