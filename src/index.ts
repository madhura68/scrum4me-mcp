#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerHealthTool } from './tools/health.js'
import { registerListProductsTool } from './tools/list-products.js'
import { registerGetClaudeContextTool } from './tools/get-claude-context.js'
import { registerUpdateTaskStatusTool } from './tools/update-task-status.js'
import { registerUpdateTaskPlanTool } from './tools/update-task-plan.js'
import { registerLogImplementationTool } from './tools/log-implementation.js'
import { registerLogTestResultTool } from './tools/log-test-result.js'
import { registerLogCommitTool } from './tools/log-commit.js'
import { registerCreatePbiTool } from './tools/create-pbi.js'
import { registerCreateStoryTool } from './tools/create-story.js'
import { registerCreateTaskTool } from './tools/create-task.js'
import { registerCreateSprintTool } from './tools/create-sprint.js'
import { registerUpdateSprintTool } from './tools/update-sprint.js'
import { registerAskUserQuestionTool } from './tools/ask-user-question.js'
import { registerGetQuestionAnswerTool } from './tools/get-question-answer.js'
import { registerListOpenQuestionsTool } from './tools/list-open-questions.js'
import { registerCancelQuestionTool } from './tools/cancel-question.js'
import { registerWaitForJobTool } from './tools/wait-for-job.js'
import { registerUpdateJobStatusTool } from './tools/update-job-status.js'
import { registerVerifyTaskAgainstPlanTool } from './tools/verify-task-against-plan.js'
import { registerCleanupMyWorktreesTool } from './tools/cleanup-my-worktrees.js'
import { registerCheckQueueEmptyTool } from './tools/check-queue-empty.js'
import { registerSetPbiPrTool } from './tools/set-pbi-pr.js'
import { registerMarkPbiPrMergedTool } from './tools/mark-pbi-pr-merged.js'
// PBI-102: ProductDoc-revision tools
import { registerCreateProductDocTool } from './tools/create-product-doc.js'
import { registerLinkPbiDocTool } from './tools/link-pbi-doc.js'
// product-docs MCP-retrieval (Deel B): 4 read-tools voor agents
import { registerListProductDocsTool } from './tools/list-product-docs.js'
import { registerGetProductDocTool } from './tools/get-product-doc.js'
import { registerSearchProductDocsTool } from './tools/search-product-docs.js'
import { registerRelatedProductDocsTool } from './tools/related-product-docs.js'
import { registerGetIdeaContextTool } from './tools/get-idea-context.js'
import { registerUpdateIdeaGrillMdTool } from './tools/update-idea-grill-md.js'
import { registerUpdateIdeaPlanMdTool } from './tools/update-idea-plan-md.js'
import { registerUpdateIdeaPlanReviewedTool } from './tools/update-idea-plan-reviewed.js'
import { registerLogIdeaDecisionTool } from './tools/log-idea-decision.js'
import { registerGetWorkerSettingsTool } from './tools/get-worker-settings.js'
import { registerWorkerHeartbeatTool } from './tools/worker-heartbeat.js'
// PBI-50: SPRINT_IMPLEMENTATION-tools
import { registerVerifySprintTaskTool } from './tools/verify-sprint-task.js'
import { registerUpdateTaskExecutionTool } from './tools/update-task-execution.js'
import { registerJobHeartbeatTool } from './tools/job-heartbeat.js'
import { registerImplementNextStoryPrompt } from './prompts/implement-next-story.js'
import { getAuth } from './auth.js'
import { registerWorker } from './presence/worker.js'
import { startHeartbeat } from './presence/heartbeat.js'
import { registerShutdownHandlers } from './presence/shutdown.js'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Read version dynamically from package.json — voorheen hardcoded en
// veroorzaakte sync-issues bij deployment. Lees op module-load.
function readPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
const VERSION = readPkgVersion()

async function main() {
  const server = new McpServer(
    { name: 'scrum4me-mcp', version: VERSION },
    {
      instructions:
        'Scrum4Me dev-flow tools: read product/sprint/story context, update tasks, log activity. ' +
        'Always call get_claude_context before starting work to fetch the next story. ' +
        'Use search_product_docs before implementing, reviewing, grilling, or chatting ' +
        'about work that touches architecture, patterns, auth, status mapping, demo policy, ' +
        'job flow, sprint flow, MD3/styling, or UI dialogs. Use Read/Grep on docs/ only as ' +
        'fallback when MCP tools return no useful result or a multi-file scan is required. ' +
        'Use related_product_docs to follow cross-references between docs. Use get_product_doc ' +
        'with `heading` parameter to focus on a section instead of loading the full doc.',
    },
  )

  registerHealthTool(server)
  registerListProductsTool(server)
  registerGetClaudeContextTool(server)
  registerUpdateTaskStatusTool(server)
  registerUpdateTaskPlanTool(server)
  registerLogImplementationTool(server)
  registerLogTestResultTool(server)
  registerLogCommitTool(server)
  registerCreatePbiTool(server)
  registerCreateStoryTool(server)
  registerCreateTaskTool(server)
  // PBI-12: sprint lifecycle tools
  registerCreateSprintTool(server)
  registerUpdateSprintTool(server)
  registerAskUserQuestionTool(server)
  registerGetQuestionAnswerTool(server)
  registerListOpenQuestionsTool(server)
  registerCancelQuestionTool(server)
  registerWaitForJobTool(server)
  registerUpdateJobStatusTool(server)
  registerVerifyTaskAgainstPlanTool(server)
  registerCleanupMyWorktreesTool(server)
  registerCheckQueueEmptyTool(server)
  registerSetPbiPrTool(server)
  registerMarkPbiPrMergedTool(server)
  // PBI-102: ProductDoc-revision tools
  registerCreateProductDocTool(server)
  registerLinkPbiDocTool(server)
  // product-docs MCP-retrieval (Deel B)
  registerListProductDocsTool(server)
  registerGetProductDocTool(server)
  registerSearchProductDocsTool(server)
  registerRelatedProductDocsTool(server)
  // M12: idee-job tools
  registerGetIdeaContextTool(server)
  registerUpdateIdeaGrillMdTool(server)
  registerUpdateIdeaPlanMdTool(server)
  registerUpdateIdeaPlanReviewedTool(server)
  registerLogIdeaDecisionTool(server)
  // M13: worker quota-gate tools
  registerGetWorkerSettingsTool(server)
  registerWorkerHeartbeatTool(server)
  // PBI-50: SPRINT_IMPLEMENTATION-tools
  registerVerifySprintTaskTool(server)
  registerUpdateTaskExecutionTool(server)
  registerJobHeartbeatTool(server)
  registerImplementNextStoryPrompt(server)

  // Presence bootstrap MUST run before server.connect — the stdio transport
  // can stall the await on incoming messages, so anything after server.connect
  // may never execute reliably. Registering the worker + starting the
  // heartbeat first guarantees the UI sees the agent as soon as the process
  // is up, regardless of when the MCP client sends its first request.
  const auth = await getAuth()
  await registerWorker({ userId: auth.userId, tokenId: auth.tokenId })
  const { stop: stopHeartbeat } = startHeartbeat({ tokenId: auth.tokenId })
  registerShutdownHandlers({ userId: auth.userId, tokenId: auth.tokenId, stopHeartbeat })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(`scrum4me-mcp ${VERSION} running on stdio`)
}

main().catch((err) => {
  console.error('Fatal error in scrum4me-mcp:', err)
  process.exit(1)
})
