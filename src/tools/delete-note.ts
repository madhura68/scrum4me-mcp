// IDEA-226 (PBI-30, T-152): permanently delete a private note.
//
// Key rule (spec, demo-negatives): `requireWriteAccess()` MUST be the first
// statement of the handler, before any input parsing or DB access (do not
// copy create-idea.ts's parse-then-auth order).
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
