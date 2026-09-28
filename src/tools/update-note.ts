// IDEA-226 (PBI-30, T-152): update one or more fields of a private note.
//
// Ordering (review T-151/152 round 1): the MCP SDK itself
// (`McpServer.validateToolInput`, SDK 1.29) validates the raw arguments
// against the published `inputSchema` below BEFORE this handler runs at
// all — but that published schema only requires `id`; the "at least one
// field besides id" rule lives in `noteUpdateSchema`'s `.refine()`, which we
// only apply *inside* the handler (see below). So `update_note { id: 'n1' }`
// alone DOES pass the SDK's pre-check and reach this handler. Key rule
// (spec, demo-negatives): `requireWriteAccess()` MUST still be the first
// statement of the handler, before that refine-check or any DB access, so a
// demo token sending exactly that input (schema-valid, refine-invalid)
// still gets PERMISSION_DENIED and never reaches the adapter — unlike
// create-idea.ts, which parses first (do not copy that order here).
//
// `id` is not part of `noteUpdateSchema` (that schema only covers the patch
// fields and their "at least one field" refine), so the published inputSchema
// combines `id` with the same field-level schemas the shared contract uses,
// and the handler re-parses the patch portion through the real
// `noteUpdateSchema` to get the canonical NoteUpdateInput + the "minstens één
// veld"-refine, in one source of truth.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { requireWriteAccess } from '../auth.js'
import { updateNote, getNote } from '../lib/notes-data.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { noteTitleSchema, noteBodySchema, noteKeywordsSchema, noteUpdateSchema } from '@shared/note-schema.js'

const inputSchema = z.object({
  id: z.string().min(1),
  title: noteTitleSchema.optional(),
  body: noteBodySchema.optional(),
  product_id: z.string().min(1).nullable().optional(),
  keywords: noteKeywordsSchema.optional(),
})

export async function handleUpdateNote(input: unknown) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const { id, ...rest } = inputSchema.parse(input)
    const patch = noteUpdateSchema.parse(rest)

    const result = await updateNote(auth.userId, id, patch)
    if (!result.ok) {
      return toolError(result.error)
    }

    const note = await getNote(auth.userId, id)
    // De `updateMany`-scoped write hierboven heeft de note al als van
    // `auth.userId` bevestigd, dus dit zou nooit null mogen zijn — behalve
    // een concurrent delete tussen de update en deze re-fetch. Faal dan
    // expliciet i.p.v. `toolJson(null)` terug te geven.
    if (!note) {
      return toolError('Note niet gevonden')
    }
    return toolJson(note)
  })
}

export function registerUpdateNoteTool(server: McpServer) {
  server.registerTool(
    'update_note',
    {
      title: 'Update note',
      description:
        "Update one or more fields of a private note owned by the token's user. Omitted fields stay unchanged; product_id: null unlinks the product. At least one field besides id is required. Forbidden for demo accounts.",
      inputSchema,
    },
    async (input) => handleUpdateNote(input),
  )
}
