import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessTask } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { buildVerifyResult, renderMarkdownReport } from '../lib/verify-plan.js'

const inputSchema = z.object({
  task_id: z.string().min(1),
})

export function registerVerifyTaskAgainstPlanTool(server: McpServer) {
  server.registerTool(
    'verify_task_against_plan',
    {
      title: 'Verify task against plan',
      description:
        'Compare the frozen plan_snapshot (captured at claim time) against current ' +
        'task.implementation_plan, story logs, and commits. Returns a markdown report ' +
        'with per-AC ✓/✗/? heuristic checks and a drift-score. Read-only — demo users allowed.',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) =>
      withToolErrors(async () => {
        const auth = await getAuth()
        if (!auth) return toolError('Unauthorized')
        if (!(await userCanAccessTask(task_id, auth.userId))) {
          return toolError(`Task ${task_id} not found or not accessible`)
        }

        const task = await prisma.task.findUnique({
          where: { id: task_id },
          select: {
            id: true,
            title: true,
            implementation_plan: true,
            story: {
              select: {
                id: true,
                acceptance_criteria: true,
                logs: {
                  orderBy: { created_at: 'asc' },
                  select: {
                    type: true,
                    content: true,
                    commit_hash: true,
                    commit_message: true,
                  },
                },
              },
            },
            claude_jobs: {
              where: { status: { in: ['CLAIMED', 'RUNNING', 'DONE', 'FAILED'] } },
              orderBy: { created_at: 'desc' },
              take: 1,
              select: { plan_snapshot: true },
            },
          },
        })

        if (!task) return toolError(`Task ${task_id} not found`)

        const latestJob = task.claude_jobs[0] ?? null
        const planSnapshot = latestJob ? latestJob.plan_snapshot : null

        const implementationLogs = task.story.logs
          .filter((l) => l.type === 'IMPLEMENTATION_PLAN')
          .map((l) => l.content)

        const commits = task.story.logs
          .filter((l) => l.type === 'COMMIT')
          .map((l) => ({ hash: l.commit_hash, message: l.commit_message }))

        const result = buildVerifyResult({
          taskId: task.id,
          taskTitle: task.title,
          planSnapshot,
          currentPlan: task.implementation_plan,
          acceptanceCriteriaText: task.story.acceptance_criteria,
          implementationLogs,
          commits,
        })

        return toolJson({
          report: renderMarkdownReport(result),
          task_id: result.taskId,
          drift_score: result.driftScore,
          ac_results: result.acceptanceCriteria,
          plan_edited: result.planEdited,
          has_baseline: result.hasBaseline,
        })
      }),
  )
}
