// MCP-tool: laadt volledige context voor een idee — voor agents die
// idee-jobs uitvoeren of via UI-acties idee-info nodig hebben.
//
// Strikt user_id-only (M12 grill-keuze 8). Demo MAY read.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userOwnsIdea } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  idea_id: z.string().min(1),
})

export function registerGetIdeaContextTool(server: McpServer) {
  server.registerTool(
    'get_idea_context',
    {
      title: 'Get idea context',
      description:
        'Fetch full idea context (idea + product + repo_url + open questions + recent logs). Strict user_id-only scope. Read-only.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ idea_id }) =>
      withToolErrors(async () => {
        const auth = await getAuth()

        const idea = await prisma.idea.findFirst({
          where: { id: idea_id, user_id: auth.userId },
          include: {
            product: {
              select: {
                id: true,
                name: true,
                code: true,
                repo_url: true,
                definition_of_done: true,
              },
            },
            pbi: { select: { id: true, code: true, title: true } },
            // PBI-102: laad content uit current_revision met fallback
            // naar legacy Idea.{grill,plan}_md (tijdens dual-write).
            plan_doc: {
              select: {
                id: true,
                slug: true,
                folder: true,
                current_revision: {
                  select: { id: true, revision: true, content_md: true },
                },
              },
            },
            grill_doc: {
              select: {
                id: true,
                slug: true,
                folder: true,
                current_revision: {
                  select: { id: true, revision: true, content_md: true },
                },
              },
            },
          },
        })
        if (!idea) {
          // 404, niet 403 — vermijdt enumeratie van andermans idea-ids.
          return toolError('Idea not found')
        }

        // Open vragen + recente logs voor agent-context.
        const [openQuestions, recentLogs] = await Promise.all([
          prisma.claudeQuestion.findMany({
            where: { idea_id: idea.id, status: 'open' },
            orderBy: { created_at: 'desc' },
            take: 10,
            select: {
              id: true,
              question: true,
              options: true,
              created_at: true,
              expires_at: true,
            },
          }),
          prisma.ideaLog.findMany({
            where: { idea_id: idea.id },
            orderBy: { created_at: 'desc' },
            take: 20,
            select: {
              id: true,
              type: true,
              content: true,
              metadata: true,
              created_at: true,
            },
          }),
        ])

        // PBI-102: prefer current_revision.content_md boven legacy
        // idea.{grill,plan}_md zodat het canonieke ProductDoc-record
        // de bron-van-waarheid is. Output-contract identiek.
        const planMd = idea.plan_doc?.current_revision?.content_md ?? idea.plan_md
        const grillMd = idea.grill_doc?.current_revision?.content_md ?? idea.grill_md

        return toolJson({
          idea: {
            id: idea.id,
            code: idea.code,
            title: idea.title,
            description: idea.description,
            grill_md: grillMd,
            plan_md: planMd,
            status: idea.status,
            product_id: idea.product_id,
            pbi_id: idea.pbi_id,
            archived: idea.archived,
            created_at: idea.created_at.toISOString(),
            updated_at: idea.updated_at.toISOString(),
          },
          product: idea.product,
          pbi: idea.pbi,
          repo_url: idea.product?.repo_url ?? null,
          grill_md_so_far: grillMd,
          // PBI-102: pointer-info voor revision-aware consumenten
          plan_doc: idea.plan_doc
            ? {
                id: idea.plan_doc.id,
                slug: idea.plan_doc.slug,
                folder: idea.plan_doc.folder,
                current_revision: idea.plan_doc.current_revision
                  ? {
                      id: idea.plan_doc.current_revision.id,
                      revision: idea.plan_doc.current_revision.revision,
                    }
                  : null,
              }
            : null,
          grill_doc: idea.grill_doc
            ? {
                id: idea.grill_doc.id,
                slug: idea.grill_doc.slug,
                folder: idea.grill_doc.folder,
                current_revision: idea.grill_doc.current_revision
                  ? {
                      id: idea.grill_doc.current_revision.id,
                      revision: idea.grill_doc.current_revision.revision,
                    }
                  : null,
              }
            : null,
          open_questions: openQuestions.map((q) => ({
            id: q.id,
            question: q.question,
            options: Array.isArray(q.options) ? (q.options as string[]) : null,
            created_at: q.created_at.toISOString(),
            expires_at: q.expires_at.toISOString(),
          })),
          recent_logs: recentLogs.map((l) => ({
            id: l.id,
            type: l.type,
            content: l.content,
            metadata: l.metadata,
            created_at: l.created_at.toISOString(),
          })),
        })

        // Note: prompt_text wordt door wait_for_job in de job-payload
        // meegestuurd (single source). get_idea_context is voor adhoc lookups
        // — geen prompt-text nodig.
        void userOwnsIdea
      }),
  )
}
