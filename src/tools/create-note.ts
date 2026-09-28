// IDEA-226 (PBI-30, T-152): create a private note for the token's user.
//
// Key rule (spec, demo-negatives): `requireWriteAccess()` MUST be the first
// statement of the handler, before any input parsing or DB access, so a demo
// token gets PERMISSION_DENIED even on malformed input and never reaches the
// adapter — unlike create-idea.ts, which parses first (do not copy that
// order here).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { requireWriteAccess } from '../auth.js'
import { createNote, getNote } from '../lib/notes-data.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { noteCreateSchema } from '@shared/note-schema.js'

export async function handleCreateNote(input: unknown) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const parsed = noteCreateSchema.parse(input)

    const result = await createNote(auth.userId, parsed)
    if (!result.ok) {
      return toolError(result.error)
    }

    // Re-fetch zodat de response de volledige note (incl. body/keywords/product)
    // teruggeeft, symmetrisch met get_note — de adapter geeft van createNote zelf
    // alleen { ok, id } terug.
    const note = await getNote(auth.userId, result.id)
    return toolJson(note)
  })
}

export function registerCreateNoteTool(server: McpServer) {
  server.registerTool(
    'create_note',
    {
      title: 'Create note',
      description:
        "Create a new private note for the token's user, optionally linked to a product and tagged with up to 10 keywords. An unknown keyword is created automatically. Forbidden for demo accounts.",
      inputSchema: noteCreateSchema,
    },
    async (input) => handleCreateNote(input),
  )
}
