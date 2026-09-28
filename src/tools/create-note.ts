// IDEA-226 (PBI-30, T-152): create a private note for the token's user.
//
// Ordering (review T-151/152 round 1): the MCP SDK itself
// (`McpServer.validateToolInput`, SDK 1.29) validates the raw arguments
// against the published `inputSchema` (`noteCreateSchema`) BEFORE this
// handler runs at all — input that fails that published shape (e.g.
// `create_note {}`, missing `title`) never reaches us; the caller gets an
// SDK-level input-validation error instead. Key rule (spec, demo-negatives):
// once we DO run, `requireWriteAccess()` MUST still be the first statement
// of the handler, before any further parsing/DB access, so a demo token
// whose input DID pass the published schema still gets PERMISSION_DENIED
// and never reaches the adapter — unlike create-idea.ts, which parses first
// (do not copy that order here).
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
    // Note is net aangemaakt binnen deze zelfde userId-scope, dus dit zou
    // nooit null mogen zijn — behalve een concurrent delete tussen de create
    // en deze re-fetch. Faal dan expliciet i.p.v. `toolJson(null)` terug te
    // geven.
    if (!note) {
      return toolError('Note niet gevonden')
    }
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
