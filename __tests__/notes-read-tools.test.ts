import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  getAuth: vi.fn(),
  // errors.ts checks `err instanceof PermissionDeniedError` unconditionally in
  // withToolErrors — the mock must export *some* class even though these
  // read-only tools never throw it themselves.
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/lib/notes-data.js', () => ({
  getNote: vi.fn(),
  listNotes: vi.fn(),
  listKeywords: vi.fn(),
}))

import { getAuth } from '../src/auth.js'
import { getNote, listNotes, listKeywords } from '../src/lib/notes-data.js'
import { handleGetNote, registerGetNoteTool } from '../src/tools/get-note.js'
import { handleSearchNotes, registerSearchNotesTool } from '../src/tools/search-notes.js'
import {
  handleListNoteKeywords,
  registerListNoteKeywordsTool,
} from '../src/tools/list-note-keywords.js'
import { toolText } from './helpers/tool-result.js'
import type { AnyMock } from './helpers/mocks.js'

const mockAuth = getAuth as AnyMock
const mockGetNote = getNote as AnyMock
const mockListNotes = listNotes as AnyMock
const mockListKeywords = listKeywords as AnyMock

type RegisteredDefinition = { description: string; inputSchema: { shape: Record<string, unknown> } }

function captureRegistration(register: (server: never) => void) {
  let definition: RegisteredDefinition | null = null
  const server = {
    registerTool: vi.fn((_name: string, def: RegisteredDefinition) => {
      definition = def
    }),
  }
  register(server as never)
  return definition!
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1', isDemo: false })
})

describe('get_note', () => {
  it('calls getNote(auth.userId, id)', async () => {
    mockGetNote.mockResolvedValue({ id: 'note-1', title: 'T', body: 'B', product: null, keywords: [] })
    await handleGetNote({ id: 'note-1' })
    expect(mockGetNote).toHaveBeenCalledWith('user-1', 'note-1')
  })

  it('null → "Note niet gevonden" (nonexistent id)', async () => {
    mockGetNote.mockResolvedValue(null)
    const res = await handleGetNote({ id: 'note-x' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toBe('Note niet gevonden')
  })

  // De adapter (getNote) bewijst zelf dat andermans note ook `null` oplevert
  // (notes-data-tests) — deze test bewijst alleen dat de tool-laag élke
  // `null` van de adapter, ongeacht de reden erachter, naar dezelfde
  // "Note niet gevonden" vertaalt (nooit een ander bericht of een 403).
  it('vertaalt elke null van getNote naar "Note niet gevonden"', async () => {
    mockGetNote.mockResolvedValue(null)
    const res = await handleGetNote({ id: 'some-id' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toBe('Note niet gevonden')
  })

  it('resultaat bevat body, keywords en product', async () => {
    mockGetNote.mockResolvedValue({
      id: 'note-1',
      title: 'T',
      body: 'the full body',
      product: { id: 'p1', name: 'Product 1' },
      keywords: [{ keyword: { id: 'k1', name: 'x', user_id: null } }],
    })
    const res = await handleGetNote({ id: 'note-1' })
    const parsed = JSON.parse(toolText(res))
    expect(parsed.body).toBe('the full body')
    expect(parsed.product).toEqual({ id: 'p1', name: 'Product 1' })
    expect(parsed.keywords).toBeDefined()
  })

  it('werkt normaal voor een demo-token', async () => {
    mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: true })
    mockGetNote.mockResolvedValue({ id: 'note-1', title: 'T', body: 'B', product: null, keywords: [] })
    const res = await handleGetNote({ id: 'note-1' })
    expect(res.isError).toBeFalsy()
  })
})

describe('search_notes', () => {
  beforeEach(() => {
    mockListNotes.mockResolvedValue({ ok: true, items: [], total: 0, limit: 20, offset: 0, has_more: false })
  })

  it('gebruikt default limit=20 en offset=0', async () => {
    await handleSearchNotes({})
    expect(mockListNotes).toHaveBeenCalledWith('user-1', expect.objectContaining({ limit: 20, offset: 0 }))
  })

  it('limit: 101 geeft VALIDATION_ERROR zonder clamp; adapter wordt niet aangeroepen', async () => {
    const res = await handleSearchNotes({ limit: 101 })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^VALIDATION_ERROR:/)
    expect(mockListNotes).not.toHaveBeenCalled()
  })

  it('output is exact { items, total, limit, offset, has_more }; geen item heeft een body-key', async () => {
    mockListNotes.mockResolvedValue({
      ok: true,
      items: [{ id: 'n1', title: 'T', product_id: null, created_at: new Date(), updated_at: new Date() }],
      total: 1,
      limit: 20,
      offset: 0,
      has_more: false,
    })
    const res = await handleSearchNotes({})
    const parsed = JSON.parse(toolText(res))
    expect(Object.keys(parsed).sort()).toEqual(['has_more', 'items', 'limit', 'offset', 'total'])
    expect(parsed.items[0].body).toBeUndefined()
  })

  it('product_id buiten toegang/scope → "Product niet gevonden"', async () => {
    mockListNotes.mockResolvedValue({ ok: false, code: 404, error: 'Product niet gevonden' })
    const res = await handleSearchNotes({ product_id: 'p-x' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toBe('Product niet gevonden')
  })

  it('werkt normaal voor een demo-token', async () => {
    mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: true })
    const res = await handleSearchNotes({})
    expect(res.isError).toBeFalsy()
  })
})

describe('list_note_keywords', () => {
  it('calls listKeywords(auth.userId)', async () => {
    mockListKeywords.mockResolvedValue([])
    await handleListNoteKeywords()
    expect(mockListKeywords).toHaveBeenCalledWith('user-1')
  })

  it('is niet gepagineerd — geeft de volledige lijst terug', async () => {
    mockListKeywords.mockResolvedValue([
      { id: 'k1', name: 'default-a', is_default: true },
      { id: 'k2', name: 'own-b', is_default: false },
    ])
    const res = await handleListNoteKeywords()
    const parsed = JSON.parse(toolText(res))
    expect(parsed).toHaveLength(2)
  })

  it('werkt normaal voor een demo-token', async () => {
    mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: true })
    mockListKeywords.mockResolvedValue([{ id: 'k1', name: 'x', is_default: true }])
    const res = await handleListNoteKeywords()
    expect(res.isError).toBeFalsy()
  })
})

describe('registratie', () => {
  it('geen van de drie inputSchemas heeft een user_id key', () => {
    const getNoteDef = captureRegistration(registerGetNoteTool)
    const searchNotesDef = captureRegistration(registerSearchNotesTool)
    const listKeywordsDef = captureRegistration(registerListNoteKeywordsTool)
    for (const def of [getNoteDef, searchNotesDef, listKeywordsDef]) {
      expect(Object.keys(def.inputSchema.shape)).not.toContain('user_id')
    }
  })
})
