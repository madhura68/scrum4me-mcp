// Central tool registration, split by where a tool can physically run.
//
//  - registerSharedTools(): tools that only touch the database or the network
//    (Forgejo REST). These are safe to serve from the centralized HTTP server,
//    multi-tenant by per-request token — the caller's identity comes from the
//    Authorization header (see request-context.ts / auth.ts).
//
//  - registerWorktreeTools(): tools bound to the *local* git worktree of the
//    worker process. They create/diff/push/remove the on-disk worktree that the
//    agent edits its code in (createWorktreeForJob, git push, git diff via
//    execFile, removeWorktreeForJob, file locks). They MUST run co-located with
//    the agent and are therefore stdio-only — a central server would operate on
//    the wrong machine's filesystem.
//
// The stdio entrypoint (index.ts) registers both; the HTTP entrypoint
// (http.ts) registers only the shared set.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerHealthTool } from './tools/health.js'
import { registerListProductsTool } from './tools/list-products.js'
import { registerGetClaudeContextTool } from './tools/get-claude-context.js'
import { registerGetAgentGuideTool } from './tools/get-agent-guide.js'
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
import { registerCheckQueueEmptyTool } from './tools/check-queue-empty.js'
import { registerSetPbiPrTool } from './tools/set-pbi-pr.js'
import { registerMarkPbiPrMergedTool } from './tools/mark-pbi-pr-merged.js'
import { registerCreateProductDocTool } from './tools/create-product-doc.js'
import { registerLinkPbiDocTool } from './tools/link-pbi-doc.js'
import { registerListProductDocsTool } from './tools/list-product-docs.js'
import { registerGetProductDocTool } from './tools/get-product-doc.js'
import { registerSearchProductDocsTool } from './tools/search-product-docs.js'
import { registerRelatedProductDocsTool } from './tools/related-product-docs.js'
import { registerGetIdeaContextTool } from './tools/get-idea-context.js'
import { registerUpdateIdeaGrillMdTool } from './tools/update-idea-grill-md.js'
import { registerUpdateIdeaPlanMdTool } from './tools/update-idea-plan-md.js'
import { registerUpdateIdeaSpecMdTool } from './tools/update-idea-spec-md.js'
import { registerUpdateIdeaPlanReviewedTool } from './tools/update-idea-plan-reviewed.js'
import { registerPostPrReviewTool } from './tools/post-pr-review.js'
import { registerSubmitReviewTool } from './tools/submit-review.js'
import { registerLogIdeaDecisionTool } from './tools/log-idea-decision.js'
import { registerGetWorkerSettingsTool } from './tools/get-worker-settings.js'
import { registerWorkerHeartbeatTool } from './tools/worker-heartbeat.js'
import { registerUpdateTaskExecutionTool } from './tools/update-task-execution.js'
import { registerJobHeartbeatTool } from './tools/job-heartbeat.js'
import { registerCreateIdeaTool } from './tools/create-idea.js'
import { registerListIdeasTool } from './tools/list-ideas.js'
import { registerUpdateIdeaTool } from './tools/update-idea.js'
import { registerDispatchJobTool } from './tools/dispatch-job.js'
import { registerGetJobStatusTool } from './tools/get-job-status.js'
import { registerGetReviewTool } from './tools/get-review.js'
import { registerListIdeaQuestionsTool } from './tools/list-idea-questions.js'
import { registerAnswerQuestionTool } from './tools/answer-question.js'
import { registerGetIdeaChatChannelTool } from './tools/get-idea-chat-channel.js'
import { registerSendIdeaChatMessageTool } from './tools/send-idea-chat-message.js'

// Worktree/local-filesystem-bound tools (stdio-only)
import { registerWaitForJobTool } from './tools/wait-for-job.js'
import { registerUpdateJobStatusTool } from './tools/update-job-status.js'
import { registerVerifyTaskAgainstPlanTool } from './tools/verify-task-against-plan.js'
import { registerVerifySprintTaskTool } from './tools/verify-sprint-task.js'
import { registerCleanupMyWorktreesTool } from './tools/cleanup-my-worktrees.js'
import { registerImplementNextStoryPrompt } from './prompts/implement-next-story.js'

/**
 * DB/network-only tools — safe for the centralized HTTP server (and also
 * registered in stdio mode). Identity is resolved per request via auth.ts.
 */
export function registerSharedTools(server: McpServer): void {
  registerHealthTool(server)
  registerListProductsTool(server)
  registerGetClaudeContextTool(server)
  registerGetAgentGuideTool(server)
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
  registerUpdateIdeaSpecMdTool(server)
  registerUpdateIdeaPlanMdTool(server)
  registerUpdateIdeaPlanReviewedTool(server)
  registerPostPrReviewTool(server)
  registerSubmitReviewTool(server)
  registerLogIdeaDecisionTool(server)
  // M13: worker quota-gate tools
  registerGetWorkerSettingsTool(server)
  registerWorkerHeartbeatTool(server)
  // PBI-50: sprint execution bookkeeping (DB-only)
  registerUpdateTaskExecutionTool(server)
  registerJobHeartbeatTool(server)
  // IDEA-118 fase 2: copilot-tools
  registerCreateIdeaTool(server)
  registerListIdeasTool(server)
  registerUpdateIdeaTool(server)
  registerDispatchJobTool(server)
  registerGetJobStatusTool(server)
  registerGetReviewTool(server)
  // Question-channel: copilot can list + answer open idea questions
  registerListIdeaQuestionsTool(server)
  registerAnswerQuestionTool(server)
  registerGetIdeaChatChannelTool(server)
  registerSendIdeaChatMessageTool(server)
}

/**
 * Worktree/local-filesystem-bound tools + the implement-next-story prompt that
 * drives them. stdio-only: these create and operate on the on-disk git worktree
 * the agent works in, so they must run co-located with the agent.
 */
export function registerWorktreeTools(server: McpServer): void {
  registerWaitForJobTool(server)
  registerUpdateJobStatusTool(server)
  registerVerifyTaskAgainstPlanTool(server)
  registerVerifySprintTaskTool(server)
  registerCleanupMyWorktreesTool(server)
  registerImplementNextStoryPrompt(server)
}
