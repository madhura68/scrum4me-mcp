// MCP-tool: schrijft het plan_md-resultaat na een IDEA_MAKE_PLAN-job en
// transitioneert de idea-status naar PLAN_READY (bij geldige yaml-frontmatter)
// of PLAN_FAILED (bij parse-fout).
//
// Wordt aangeroepen door de worker als laatste stap van een make-plan-sessie.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userOwnsIdea } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { parsePlanMd } from '../lib/idea-plan-parser.js'

const inputSchema = z.object({
  idea_id: z.string().min(1),
  markdown: z.string().min(1).max(64_000),
})

export function registerUpdateIdeaPlanMdTool(server: McpServer) {
  server.registerTool(
    'update_idea_plan_md',
    {
      title: 'Update idea plan_md',
      description:
        'Save the make-plan-result markdown for an idea. Server validates yaml-frontmatter; on success status → PLAN_READY, on parse-fail → PLAN_FAILED. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ idea_id, markdown }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userOwnsIdea(idea_id, auth.userId))) {
          return toolError('Idea not found')
        }

        const parsed = parsePlanMd(markdown)

        if (!parsed.ok) {
          // Persist md + flip to PLAN_FAILED + log de errors zodat de UI ze
          // aan de user kan tonen.
          const result = await prisma.$transaction([
            prisma.idea.update({
              where: { id: idea_id },
              data: { plan_md: markdown, status: 'PLAN_FAILED' },
              select: { id: true, status: true, code: true },
            }),
            prisma.ideaLog.create({
              data: {
                idea_id,
                type: 'JOB_EVENT',
                content: 'plan_md parse failed',
                metadata: { errors: parsed.errors },
              },
            }),
          ])
          return toolJson({
            ok: false,
            idea: result[0],
            errors: parsed.errors,
          })
        }

        const result = await prisma.$transaction([
          prisma.idea.update({
            where: { id: idea_id },
            data: { plan_md: markdown, status: 'PLAN_READY' },
            select: { id: true, status: true, code: true },
          }),
          prisma.ideaLog.create({
            data: {
              idea_id,
              type: 'PLAN_RESULT',
              content: `Plan ready: ${parsed.plan.stories.length} stories, ${parsed.plan.stories.reduce((n, s) => n + s.tasks.length, 0)} tasks`,
              metadata: {
                pbi_title: parsed.plan.pbi.title,
                story_count: parsed.plan.stories.length,
                task_count: parsed.plan.stories.reduce((n, s) => n + s.tasks.length, 0),
              },
            },
          }),
        ])

        return toolJson({
          ok: true,
          idea: result[0],
        })
      }),
  )
}
