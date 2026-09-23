import { expect } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toolText } from './tool-result.js'

export function captureContextTools(register: (server: McpServer) => void) {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>()
  const definitions = new Map<string, { inputSchema: { parse: (args: unknown) => unknown }; annotations?: unknown }>()
  register({
    registerTool(name: string, definition: never, handler: (args: Record<string, unknown>) => Promise<CallToolResult>) {
      definitions.set(name, definition)
      handlers.set(name, handler)
    },
    registerPrompt() {},
  } as unknown as McpServer)
  return {
    handlers,
    definitions,
    async call(name: string, args: Record<string, unknown>) {
      expect(handlers.has(name), `read tool ${name} must be available`).toBe(true)
      return handlers.get(name)!(args)
    },
    async json(name: string, args: Record<string, unknown>) {
      const result = await this.call(name, args)
      expect(result.isError, toolText(result)).not.toBe(true)
      return JSON.parse(toolText(result))
    },
  }
}
