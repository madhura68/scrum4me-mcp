// IDEA-226 (PBI-30, T-152): permanently delete a private note.
//
// Ordering (review T-151/152 round 1): the MCP SDK itself
// (`McpServer.validateToolInput`, SDK 1.29) validates the raw arguments
// against the published `inputSchema` (`{ id: string, min 1 }`) BEFORE this
// handler runs at all — `delete_note {}` (missing `id`) never reaches us;
// the caller gets an SDK-level input-validation error instead. Key rule
// (spec, demo-negatives): once we DO run, `requireWriteAccess()` MUST still
// be the first statement of the handler, before any further parsing/DB
// access, so a demo token whose input DID pass the published schema still
// gets PERMISSION_DENIED and never reaches the adapter — unlike
// create-idea.ts, which parses first (do not copy that order here).
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { requireWriteAccess } from '../auth.js'
import { deleteNote } from '../lib/notes-data.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  id: z.string().min(1),
})

export async function handleDeleteNote(input: unknown) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const { id } = inputSchema.parse(input)

    const deleted = await deleteNote(auth.userId, id)
    if (!deleted) {
      // Nonexistent id en andermans note geven identiek dezelfde 404 — nooit
      // 403 (spec § 4.1).
      return toolError('Note niet gevonden')
    }

    return toolJson({ ok: true })
  })
}

export function registerDeleteNoteTool(server: McpServer) {
  server.registerTool(
    'delete_note',
    {
      title: 'Delete note',
      description:
        "Permanently delete a private note owned by the token's user. Forbidden for demo accounts.",
      inputSchema,
    },
    async (input) => handleDeleteNote(input),
  )
}
