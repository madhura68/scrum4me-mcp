// IDEA-226 (PBI-30, T-151): list keywords available to the token's user for
// tagging notes — the shared defaults plus the user's own. Not paginated.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAuth } from '../auth.js'
import { listKeywords } from '../lib/notes-data.js'
import { toolJson, withToolErrors } from '../errors.js'

export async function handleListNoteKeywords() {
  return withToolErrors(async () => {
    const auth = await getAuth()
    const keywords = await listKeywords(auth.userId)
    return toolJson(keywords)
  })
}

export function registerListNoteKeywordsTool(server: McpServer) {
  server.registerTool(
    'list_note_keywords',
    {
      title: 'List note keywords',
      description:
        "List every keyword available to the token's user for tagging notes: shared defaults plus the user's own keywords, defaults first. Not paginated.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => handleListNoteKeywords(),
  )
}
