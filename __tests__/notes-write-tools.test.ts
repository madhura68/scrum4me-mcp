import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth.js')>()
  return { ...actual, requireWriteAccess: vi.fn() }
})
vi.mock('../src/lib/notes-data.js', () => ({
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  getNote: vi.fn(),
}))

import { requireWriteAccess, PermissionDeniedError } from '../src/auth.js'
import { createNote, updateNote, deleteNote, getNote } from '../src/lib/notes-data.js'
import { handleCreateNote, registerCreateNoteTool } from '../src/tools/create-note.js'
import { handleUpdateNote, registerUpdateNoteTool } from '../src/tools/update-note.js'
import { handleDeleteNote, registerDeleteNoteTool } from '../src/tools/delete-note.js'
import { toolText } from './helpers/tool-result.js'
import type { AnyMock } from './helpers/mocks.js'

const mockAuth = requireWriteAccess as AnyMock
const mockCreate = createNote as AnyMock
const mockUpdate = updateNote as AnyMock
const mockDelete = deleteNote as AnyMock
const mockGetNote = getNote as AnyMock

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

function denyDemo() {
  mockAuth.mockRejectedValue(new PermissionDeniedError())
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1', isDemo: false })
})

describe('demo-guard — PERMISSION_DENIED, geen enkele adapter-call', () => {
  it('create_note: demo-token krijgt PERMISSION_DENIED, createNote wordt niet aangeroepen (ook bij ongeldige input)', async () => {
    denyDemo()
    const res = await handleCreateNote({}) // title ontbreekt — ongeldig
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^PERMISSION_DENIED:/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('update_note: demo-token krijgt PERMISSION_DENIED, updateNote wordt niet aangeroepen (ook bij ongeldige input)', async () => {
    denyDemo()
    const res = await handleUpdateNote({}) // id ontbreekt — ongeldig
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^PERMISSION_DENIED:/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('delete_note: demo-token krijgt PERMISSION_DENIED, deleteNote wordt niet aangeroepen (ook bij ongeldige input)', async () => {
    denyDemo()
    const res = await handleDeleteNote({}) // id ontbreekt — ongeldig
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^PERMISSION_DENIED:/)
    expect(mockDelete).not.toHaveBeenCalled()
  })
})

describe('requireWriteAccess is de eerste call in elke handler', () => {
  it('create_note: auth loopt vóór de adapter bij geldige input', async () => {
    mockCreate.mockResolvedValue({ ok: true, id: 'n1' })
    mockGetNote.mockResolvedValue({ id: 'n1', title: 'T', body: 'B' })
    await handleCreateNote({ title: 'T', body: 'B' })
    expect(mockAuth.mock.invocationCallOrder[0]).toBeLessThan(mockCreate.mock.invocationCallOrder[0])
  })

  it('update_note: auth loopt vóór de adapter bij geldige input', async () => {
    mockUpdate.mockResolvedValue({ ok: true })
    mockGetNote.mockResolvedValue({ id: 'n1', title: 'T' })
    await handleUpdateNote({ id: 'n1', title: 'T' })
    expect(mockAuth.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[0])
  })

  it('delete_note: auth loopt vóór de adapter bij geldige input', async () => {
    mockDelete.mockResolvedValue(true)
    await handleDeleteNote({ id: 'n1' })
    expect(mockAuth.mock.invocationCallOrder[0]).toBeLessThan(mockDelete.mock.invocationCallOrder[0])
  })

  it('create_note: bij ongeldige input krijgen we PERMISSION_DENIED (niet VALIDATION_ERROR) — bewijst dat auth vóór parsing draait', async () => {
    denyDemo()
    const res = await handleCreateNote({ title: 123 }) // verkeerd type — zou VALIDATION_ERROR zijn zónder de guard
    expect(toolText(res)).toMatch(/^PERMISSION_DENIED:/)
  })

  it('update_note: bij ongeldige input krijgen we PERMISSION_DENIED (niet VALIDATION_ERROR)', async () => {
    denyDemo()
    const res = await handleUpdateNote({ id: '' }) // lege id — zou VALIDATION_ERROR zijn zónder de guard
    expect(toolText(res)).toMatch(/^PERMISSION_DENIED:/)
  })

  it('delete_note: bij ongeldige input krijgen we PERMISSION_DENIED (niet VALIDATION_ERROR)', async () => {
    denyDemo()
    const res = await handleDeleteNote({ id: '' })
    expect(toolText(res)).toMatch(/^PERMISSION_DENIED:/)
  })
})

describe('registratie', () => {
  it('elke write-tool beschrijving eindigt op "Forbidden for demo accounts."', () => {
    const createDef = captureRegistration(registerCreateNoteTool)
    const updateDef = captureRegistration(registerUpdateNoteTool)
    const deleteDef = captureRegistration(registerDeleteNoteTool)
    for (const def of [createDef, updateDef, deleteDef]) {
      expect(def.description.endsWith('Forbidden for demo accounts.')).toBe(true)
    }
  })

  it('geen enkele inputSchema heeft een user_id key', () => {
    const createDef = captureRegistration(registerCreateNoteTool)
    const updateDef = captureRegistration(registerUpdateNoteTool)
    const deleteDef = captureRegistration(registerDeleteNoteTool)
    for (const def of [createDef, updateDef, deleteDef]) {
      expect(Object.keys(def.inputSchema.shape)).not.toContain('user_id')
    }
  })
})

describe('create_note', () => {
  it('title, body, product_id, keywords gaan via noteCreateSchema naar de adapter; response = de volledige note (re-fetch)', async () => {
    mockCreate.mockResolvedValue({ ok: true, id: 'n1' })
    mockGetNote.mockResolvedValue({ id: 'n1', title: 'T', body: 'B', product: null, keywords: [] })

    const res = await handleCreateNote({ title: 'T', body: 'B', product_id: 'p1', keywords: ['a', 'b'] })

    expect(res.isError).toBeFalsy()
    expect(mockCreate).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: 'T', body: 'B', product_id: 'p1', keywords: ['a', 'b'] }),
    )
    expect(mockGetNote).toHaveBeenCalledWith('user-1', 'n1')
    expect(JSON.parse(toolText(res))).toMatchObject({ id: 'n1', body: 'B' })
  })

  it('onbekend keyword wordt gewoon meegestuurd naar de adapter (die het zelf aanmaakt)', async () => {
    mockCreate.mockResolvedValue({ ok: true, id: 'n1' })
    mockGetNote.mockResolvedValue({ id: 'n1', title: 'T', keywords: [] })
    await handleCreateNote({ title: 'T', keywords: ['nieuw-keyword'] })
    expect(mockCreate).toHaveBeenCalledWith('user-1', expect.objectContaining({ keywords: ['nieuw-keyword'] }))
  })

  it('product buiten scope/toegang → "Product niet gevonden", er wordt niets geschreven', async () => {
    mockCreate.mockResolvedValue({ ok: false, code: 404, error: 'Product niet gevonden' })
    const res = await handleCreateNote({ title: 'T', product_id: 'p-x' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toBe('Product niet gevonden')
    expect(mockGetNote).not.toHaveBeenCalled()
  })
})

describe('update_note', () => {
  it('{} (alleen id) → VALIDATION_ERROR "minstens één veld"; adapter niet aangeroepen', async () => {
    const res = await handleUpdateNote({ id: 'n1' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^VALIDATION_ERROR:/)
    expect(toolText(res)).toMatch(/minstens één veld/i)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['title', null],
    ['body', null],
    ['keywords', null],
  ])('%s: null → VALIDATION_ERROR; adapter niet aangeroepen', async (field, value) => {
    const res = await handleUpdateNote({ id: 'n1', [field]: value })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^VALIDATION_ERROR:/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('product_id: null ontkoppelt het product', async () => {
    mockUpdate.mockResolvedValue({ ok: true })
    mockGetNote.mockResolvedValue({ id: 'n1', title: 'T', product: null })
    const res = await handleUpdateNote({ id: 'n1', product_id: null })
    expect(res.isError).toBeFalsy()
    expect(mockUpdate).toHaveBeenCalledWith('user-1', 'n1', expect.objectContaining({ product_id: null }))
  })

  it('andermans of niet-bestaande id → "Note niet gevonden"', async () => {
    mockUpdate.mockResolvedValue({ ok: false, code: 404, error: 'Note niet gevonden' })
    const res = await handleUpdateNote({ id: 'n-other', title: 'T' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toBe('Note niet gevonden')
  })

  it('product buiten scope/toegang → "Product niet gevonden"', async () => {
    mockUpdate.mockResolvedValue({ ok: false, code: 404, error: 'Product niet gevonden' })
    const res = await handleUpdateNote({ id: 'n1', product_id: 'p-x' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toBe('Product niet gevonden')
  })

  it('id moet een niet-lege string zijn — VALIDATION_ERROR vóór de adapter', async () => {
    const res = await handleUpdateNote({ id: '', title: 'T' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^VALIDATION_ERROR:/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('id ontbrekend — VALIDATION_ERROR vóór de adapter', async () => {
    const res = await handleUpdateNote({ title: 'T' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^VALIDATION_ERROR:/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('delete_note', () => {
  it('andermans of niet-bestaande id → "Note niet gevonden"', async () => {
    mockDelete.mockResolvedValue(false)
    const res = await handleDeleteNote({ id: 'n-x' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toBe('Note niet gevonden')
  })

  it('eigen note → ok', async () => {
    mockDelete.mockResolvedValue(true)
    const res = await handleDeleteNote({ id: 'n1' })
    expect(res.isError).toBeFalsy()
    expect(mockDelete).toHaveBeenCalledWith('user-1', 'n1')
  })

  it('id moet een niet-lege string zijn — VALIDATION_ERROR vóór de adapter', async () => {
    const res = await handleDeleteNote({ id: '' })
    expect(res.isError).toBe(true)
    expect(toolText(res)).toMatch(/^VALIDATION_ERROR:/)
    expect(mockDelete).not.toHaveBeenCalled()
  })
})
