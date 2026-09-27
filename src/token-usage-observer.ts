import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { authenticatedCallContext } from './request-context.js'

import type { TokenUsage } from '@shared/api-token-usage.js'
export type { TokenUsage } from '@shared/api-token-usage.js'

/** Observe the complete SDK handler, including its output-schema validation. */
export function installTokenUsageObserver(
  server: McpServer,
  record: (usage: TokenUsage) => Promise<void>,
): void {
  const original = server.server.setRequestHandler.bind(server.server)
  server.server.setRequestHandler = (schema, handler) => {
    if (!Object.is(schema, CallToolRequestSchema)) return original(schema, handler)
    return original(schema, (request, extra) => authenticatedCallContext.run({}, async () => {
      const result = await handler(request, extra)
      const identity = authenticatedCallContext.getStore()?.identity
      const parsed = CallToolResultSchema.safeParse(result)
      if (identity && parsed.success && parsed.data.isError !== true && !extra.signal.aborted) {
        const usage = { ...identity, completedAt: new Date() }
        // Telemetry must never change a completed business result.
        try { await record(usage) } catch {
          try { console.error('api_token_usage_write_failed interface=mcp') } catch { /* nonfatal */ }
        }
      }
      return result
    }))
  }
}
