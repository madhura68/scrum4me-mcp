// IDEA-226 (PBI-30, T-151): read één private note inclusief body. Notes zijn
// gescoped op de gebruiker van het token, niet op product (spec § 4.1) — dit
// is de enige tool die een body teruggeeft (spec § 4.4).
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAuth } from '../auth.js'
import { getNote } from '../lib/notes-data.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  id: z.string().min(1),
})

export async function handleGetNote(input: unknown) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await getAuth()

    const note = await getNote(auth.userId, parsed.id)
    // Nonexistent id en andermans note geven identiek dezelfde 404 — nooit
    // 403, dat zou het bestaan van andermans note verraden (spec § 4.1).
    if (!note) {
      return toolError('Note niet gevonden')
    }

    return toolJson(note)
  })
}

export function registerGetNoteTool(server: McpServer) {
  server.registerTool(
    'get_note',
    {
      title: 'Get note',
      description:
        "Fetch one private note by id, including its body, keywords and linked product. Notes are private to the token's user — this is the only note tool that returns the body; search_notes never does.",
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => handleGetNote(input),
  )
}
