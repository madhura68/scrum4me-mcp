// IDEA-226 (PBI-30, T-151): search/list private notes by text, product or
// keyword. Results never carry a body (spec § 4.4) — use get_note for that.
// `searchNotesInputSchema` is the shared contract (web + mcp identical).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAuth } from '../auth.js'
import { listNotes } from '../lib/notes-data.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { searchNotesInputSchema } from '@shared/note-schema.js'

export async function handleSearchNotes(input: unknown) {
  return withToolErrors(async () => {
    const parsed = searchNotesInputSchema.parse(input)
    const auth = await getAuth()

    const result = await listNotes(auth.userId, {
      q: parsed.query,
      productId: parsed.product_id,
      keyword: parsed.keyword,
      limit: parsed.limit,
      offset: parsed.offset,
    })
    if (!result.ok) {
      return toolError(result.error)
    }

    return toolJson({
      items: result.items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      has_more: result.has_more,
    })
  })
}

export function registerSearchNotesTool(server: McpServer) {
  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        "Search the token user's private notes by free text, product or keyword, paginated (limit default 20, max 100). Results never include the note body — call get_note with an id to read one.",
      inputSchema: searchNotesInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => handleSearchNotes(input),
  )
}
