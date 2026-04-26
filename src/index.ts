#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

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

  // Tools and prompts will be registered here in ST-705..ST-709.

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`scrum4me-mcp ${VERSION} running on stdio`)
}

main().catch((err) => {
  console.error('Fatal error in scrum4me-mcp:', err)
  process.exit(1)
})
