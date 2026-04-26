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
import { registerCreateTodoTool } from './tools/create-todo.js'
import { registerImplementNextStoryPrompt } from './prompts/implement-next-story.js'

const VERSION = '0.1.0'

async function main() {
  const server = new McpServer(
    { name: 'scrum4me-mcp', version: VERSION },
    {
      instructions:
        'Scrum4Me dev-flow tools: read product/sprint/story context, update tasks, log activity. ' +
        'Always call get_claude_context before starting work to fetch the next story.',
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
  registerCreateTodoTool(server)
  registerImplementNextStoryPrompt(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`scrum4me-mcp ${VERSION} running on stdio`)
}

main().catch((err) => {
  console.error('Fatal error in scrum4me-mcp:', err)
  process.exit(1)
})
