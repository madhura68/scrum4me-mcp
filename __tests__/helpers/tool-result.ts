// Test helper — narrows the MCP SDK's tool-result content union to a text block.
//
// `CallToolResult['content']` is a union (text | image | audio | resource_link |
// embedded resource), so `result.content[0].text` does not typecheck for any handler
// annotated with that SDK type. Handlers that return an inferred object literal keep
// working without this helper; use it where the return type is `CallToolResult`.
//
// This asserts rather than falls back to '': a handler that suddenly returns a
// non-text block should fail loudly instead of silently comparing against ''.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export function toolText(result: { content: CallToolResult['content'] }, index = 0): string {
  const block = result.content[index]
  if (!block || block.type !== 'text') {
    throw new Error(
      `expected a text content block at index ${index}, got ${block ? block.type : 'nothing'}`,
    )
  }
  return block.text
}
