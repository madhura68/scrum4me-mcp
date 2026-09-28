// __tests__/notes-data.test.ts
// Data-access-adapter voor notes (IDEA-226, PBI-30, T-150) — pariteitsmodel:
// Scrum4Me `lib/notes-server.ts` (functies, foutuitkomsten, transacties).
// MCP-afwijking van web (§ 2.5 spec): een `productId`-filter op `listNotes`
// buiten de tokenscope/toegang geeft "Product niet gevonden" i.p.v. het
// filter te negeren; de productcheck gaat hier via `userCanAccessProduct`
// (`src/access.ts`), die `scoped_products` van het token al afdwingt.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock wordt gehesen; directe const-referenties in de factory zitten dan in
// hun temporal dead zone. Repo-conventie (__tests__/lib/*.test.ts): vi.hoisted().
const { tx, mockTransaction, prismaNote, prismaNoteKeyword } = vi.hoisted(() => {
  const tx = {
    note: { create: vi.fn(), updateMany: vi.fn() },
    noteKeyword: { findMany: vi.fn(), createMany: vi.fn() },
    noteKeywordLink: { deleteMany: vi.fn(), createMany: vi.fn() },
  }
  const prismaNote = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
  }
  const prismaNoteKeyword = { findMany: vi.fn() }

  // `listNotes` roept `prisma.$transaction([...])` aan (array-vorm, batched
  // queries), terwijl `createNote`/`updateNote` de callback-vorm gebruiken
  // (`prisma.$transaction(async (tx) => ...)`). Deze mock ondersteunt beide.
  const mockTransaction = vi.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (t: unknown) => Promise<unknown>)(tx)
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg)
    }
    throw new Error('onverwacht $transaction-argument in test-mock')
  })

  return { tx, mockTransaction, prismaNote, prismaNoteKeyword }
})

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: mockTransaction,
    note: prismaNote,
    noteKeyword: prismaNoteKeyword,
  },
}))

const mockUserCanAccessProduct = vi.hoisted(() => vi.fn())
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: mockUserCanAccessProduct,
}))

import {
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  listKeywords,
} from '../src/lib/notes-data.js'
import {
  noteBodySchema,
  noteTitleSchema,
  noteKeywordsSchema,
} from '@shared/note-schema.js'

type MockCallArg = Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  mockUserCanAccessProduct.mockResolvedValue(true)
  tx.note.updateMany.mockResolvedValue({ count: 1 })
  tx.noteKeywordLink.deleteMany.mockResolvedValue({ count: 0 })
  tx.noteKeywordLink.createMany.mockResolvedValue({ count: 0 })
})

describe('listKeywords (spec § 2.5, § 4.3) — defaults + eigen keywords, niet gepagineerd', () => {
  it('vraagt defaults (user_id null) + eigen keywords van userId op', async () => {
    prismaNoteKeyword.findMany.mockResolvedValue([])

    await listKeywords('user-1')

    expect(prismaNoteKeyword.findMany).toHaveBeenCalledWith({
      where: { OR: [{ user_id: null }, { user_id: 'user-1' }] },
      select: { id: true, name: true, user_id: true },
    })
  })

  it('sorteert defaults eerst, dan alfabetisch binnen elke groep', async () => {
    prismaNoteKeyword.findMany.mockResolvedValue([
      { id: 'k-own-b', name: 'zulu', user_id: 'user-1' },
      { id: 'k-def-b', name: 'todo', user_id: null },
      { id: 'k-own-a', name: 'alpha', user_id: 'user-1' },
      { id: 'k-def-a', name: 'git', user_id: null },
    ])

    const result = await listKeywords('user-1')

    expect(result).toEqual([
      { id: 'k-def-a', name: 'git', is_default: true },
      { id: 'k-def-b', name: 'todo', is_default: true },
      { id: 'k-own-a', name: 'alpha', is_default: false },
      { id: 'k-own-b', name: 'zulu', is_default: false },
    ])
  })
})

describe('listNotes (spec § 2.5, § 4.1, § 4.4) — user-scoping, select, paginering', () => {
  beforeEach(() => {
    prismaNote.findMany.mockResolvedValue([])
    prismaNote.count.mockResolvedValue(0)
  })

  it('findMany en count krijgen user_id in de where; count-where === findMany-where', async () => {
    const result = await listNotes('user-1', { limit: 20, offset: 0 })

    expect(result.ok).toBe(true)
    const findManyWhere = (prismaNote.findMany.mock.calls[0][0] as MockCallArg).where as MockCallArg
    const countWhere = (prismaNote.count.mock.calls[0][0] as MockCallArg).where as MockCallArg
    expect(findManyWhere).toMatchObject({ user_id: 'user-1' })
    expect(countWhere).toEqual(findManyWhere)
  })

  it('select is exact NOTE_LIST_FIELDS (geen body); orderBy = NOTE_LIST_ORDER; skip/take uit offset/limit', async () => {
    await listNotes('user-1', { limit: 20, offset: 40 })

    const call = prismaNote.findMany.mock.calls[0][0] as MockCallArg
    expect(call.select).not.toHaveProperty('body')
    expect(call.select).toMatchObject({ id: true, title: true, product_id: true, created_at: true, updated_at: true })
    expect(call.orderBy).toEqual([{ updated_at: 'desc' }, { id: 'desc' }])
    expect(call.skip).toBe(40)
    expect(call.take).toBe(20)
  })

  it('has_more = offset + items.length < total', async () => {
    prismaNote.findMany.mockResolvedValue([{ id: 'n-1' }, { id: 'n-2' }])
    prismaNote.count.mockResolvedValue(5)

    const result = await listNotes('user-1', { limit: 2, offset: 0 })

    expect(result).toMatchObject({ ok: true, total: 5, limit: 2, offset: 0, has_more: true })
  })

  it('has_more is false als offset + items.length === total', async () => {
    prismaNote.findMany.mockResolvedValue([{ id: 'n-1' }])
    prismaNote.count.mockResolvedValue(3)

    const result = await listNotes('user-1', { limit: 20, offset: 2 })

    expect(result).toMatchObject({ ok: true, has_more: false })
  })

  it('combineert q + productId + keyword tot één where (OR title/body insensitive, product_id, keywords.some)', async () => {
    await listNotes('user-1', { q: 'foo', productId: 'prod-1', keyword: ' Bar ', limit: 20, offset: 0 })

    const where = (prismaNote.findMany.mock.calls[0][0] as MockCallArg).where as MockCallArg
    expect(where).toEqual({
      user_id: 'user-1',
      OR: [
        { title: { contains: 'foo', mode: 'insensitive' } },
        { body: { contains: 'foo', mode: 'insensitive' } },
      ],
      product_id: 'prod-1',
      keywords: {
        some: {
          keyword: {
            name: 'bar',
            OR: [{ user_id: null }, { user_id: 'user-1' }],
          },
        },
      },
    })
  })

  it('MCP-afwijking van web (spec § 2.5): productId buiten tokenscope/toegang → "Product niet gevonden", geen query op note', async () => {
    mockUserCanAccessProduct.mockResolvedValue(false)

    const result = await listNotes('user-1', { productId: 'prod-x', limit: 20, offset: 0 })

    expect(result).toEqual({ ok: false, code: 404, error: 'Product niet gevonden' })
    expect(mockUserCanAccessProduct).toHaveBeenCalledWith('prod-x', 'user-1')
    expect(prismaNote.findMany).not.toHaveBeenCalled()
    expect(prismaNote.count).not.toHaveBeenCalled()
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('zonder productId-filter: alleen user_id-scoping (zoals web), geen productcheck', async () => {
    await listNotes('user-1', { limit: 20, offset: 0 })

    expect(mockUserCanAccessProduct).not.toHaveBeenCalled()
    const where = (prismaNote.findMany.mock.calls[0][0] as MockCallArg).where as MockCallArg
    expect(where).toEqual({ user_id: 'user-1' })
  })
})

describe('getNote (spec § 4.1, § 4.4) — scoping en bodycontract', () => {
  it("getNote('user-b', noteVanA) → null; where bevat user_id: 'user-b'", async () => {
    prismaNote.findFirst.mockResolvedValue(null)

    const result = await getNote('user-b', 'note-van-a')

    expect(result).toBeNull()
    const call = prismaNote.findFirst.mock.calls[0][0] as MockCallArg
    expect(call.where).toEqual({ id: 'note-van-a', user_id: 'user-b' })
  })

  it('select is NOTE_DETAIL_FIELDS (mét body)', async () => {
    prismaNote.findFirst.mockResolvedValue(null)

    await getNote('user-1', 'note-1')

    const select = (prismaNote.findFirst.mock.calls[0][0] as MockCallArg).select as MockCallArg
    expect(select).toHaveProperty('body', true)
  })
})

describe('deleteNote (spec § 4.1) — scoping', () => {
  it('scoped deleteMany op id + user_id; count 1 → true', async () => {
    prismaNote.deleteMany.mockResolvedValue({ count: 1 })

    const ok = await deleteNote('user-1', 'note-1')

    expect(ok).toBe(true)
    expect(prismaNote.deleteMany).toHaveBeenCalledWith({
      where: { id: 'note-1', user_id: 'user-1' },
    })
  })

  it('count 0 (andermans note of al weg) → false', async () => {
    prismaNote.deleteMany.mockResolvedValue({ count: 0 })

    expect(await deleteNote('user-1', 'note-x')).toBe(false)
  })
})

describe('Productcheck (create + update) — spec § 4.1: ontoegankelijk product → 404, niets geschreven', () => {
  it('createNote: userCanAccessProduct false → 404, geen transactie/create', async () => {
    mockUserCanAccessProduct.mockResolvedValue(false)

    const result = await createNote('user-1', {
      title: 'T',
      body: '',
      product_id: 'prod-x',
      keywords: [],
    })

    expect(result).toEqual({ ok: false, code: 404, error: 'Product niet gevonden' })
    expect(mockUserCanAccessProduct).toHaveBeenCalledWith('prod-x', 'user-1')
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(tx.note.create).not.toHaveBeenCalled()
  })

  it('updateNote: userCanAccessProduct false → 404, geen updateMany', async () => {
    mockUserCanAccessProduct.mockResolvedValue(false)

    const result = await updateNote('user-1', 'note-1', { product_id: 'prod-x' })

    expect(result).toEqual({ ok: false, code: 404, error: 'Product niet gevonden' })
    expect(tx.note.updateMany).not.toHaveBeenCalled()
  })
})

describe('updateNote — scoping en NOTE_NOT_FOUND (spec § 4.1)', () => {
  it('update via tx.note.updateMany({ where: { id, user_id } }) met count-check', async () => {
    const result = await updateNote('user-1', 'note-1', { title: 'Nieuwe titel' })

    expect(result).toEqual({ ok: true })
    const [{ where }] = tx.note.updateMany.mock.calls[0] as [{ where: Record<string, unknown> }]
    expect(where).toEqual({ id: 'note-1', user_id: 'user-1' })
  })

  it("updateNote op andermans id (count 0) → NOTE_NOT_FOUND, zelfde uitkomst als onbestaand id", async () => {
    tx.note.updateMany.mockResolvedValue({ count: 0 })

    const result = await updateNote('user-1', 'note-x', { title: 'X' })

    expect(result).toEqual({ ok: false, code: 404, error: 'Note niet gevonden' })
    expect(tx.noteKeywordLink.deleteMany).not.toHaveBeenCalled()
  })

  it('count !== 1 (bv. 2) gooit binnen de transactie i.p.v. stil te returnen (rollback)', async () => {
    tx.note.updateMany.mockResolvedValue({ count: 2 })
    let transactionRejected = false
    mockTransaction.mockImplementationOnce(async (arg: unknown) => {
      try {
        return await (arg as (t: unknown) => Promise<unknown>)(tx)
      } catch (err) {
        transactionRejected = true
        throw err
      }
    })

    const result = await updateNote('user-1', 'note-1', { title: 'Overschreven' })

    expect(result).toEqual({ ok: false, code: 404, error: 'Note niet gevonden' })
    expect(transactionRejected).toBe(true)
  })
})

describe('updateNote — mutatiesemantiek § 2.5.1', () => {
  it('weggelaten velden blijven onaangeroerd; alleen title in data', async () => {
    const result = await updateNote('user-1', 'note-1', { title: 'Nieuwe titel' })

    expect(result).toEqual({ ok: true })
    const [{ data }] = tx.note.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }]
    expect(data.title).toBe('Nieuwe titel')
    expect(data).not.toHaveProperty('body')
    expect(data).not.toHaveProperty('product_id')
    expect(tx.noteKeywordLink.deleteMany).not.toHaveBeenCalled()
  })

  it('elke update bumpt updated_at, ook als alleen keywords wijzigen', async () => {
    tx.noteKeyword.findMany.mockResolvedValue([{ id: 'kw-git', name: 'git', user_id: null }])

    const result = await updateNote('user-1', 'note-1', { keywords: ['git'] })

    expect(result).toEqual({ ok: true })
    const [{ data }] = tx.note.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }]
    expect(data.updated_at).toBeInstanceOf(Date)
  })

  it('product_id: null ontkoppelt het product, zonder productcheck', async () => {
    const result = await updateNote('user-1', 'note-1', { product_id: null })

    expect(result).toEqual({ ok: true })
    expect(mockUserCanAccessProduct).not.toHaveBeenCalled()
    const [{ data }] = tx.note.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }]
    expect(data.product_id).toBeNull()
  })

  it('keywords: [] wist alle links, maakt niets nieuw aan', async () => {
    tx.noteKeyword.findMany.mockResolvedValue([])

    const result = await updateNote('user-1', 'note-1', { keywords: [] })

    expect(result).toEqual({ ok: true })
    expect(tx.noteKeywordLink.deleteMany).toHaveBeenCalledWith({ where: { note_id: 'note-1' } })
    expect(tx.noteKeywordLink.createMany).not.toHaveBeenCalled()
    expect(tx.noteKeyword.createMany).not.toHaveBeenCalled()
  })

  it("keywords: ['a'] op een note met bestaande [a,b]-links laat alleen a over (volledige vervanging)", async () => {
    tx.noteKeyword.findMany.mockResolvedValue([{ id: 'kw-a', name: 'a', user_id: null }])

    const result = await updateNote('user-1', 'note-1', { keywords: ['a'] })

    expect(result).toEqual({ ok: true })
    expect(tx.noteKeywordLink.deleteMany).toHaveBeenCalledWith({ where: { note_id: 'note-1' } })
    expect(tx.noteKeywordLink.createMany).toHaveBeenCalledWith({
      data: [{ note_id: 'note-1', keyword_id: 'kw-a' }],
    })
    expect(tx.noteKeyword.createMany).not.toHaveBeenCalled()
  })

  it('links wissen + opnieuw leggen gebeurt in dezelfde $transaction als de note-write', async () => {
    tx.noteKeyword.findMany.mockResolvedValue([])

    await updateNote('user-1', 'note-1', { keywords: [] })

    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })
})

describe('createNote — resolveKeywords (spec § 4.3)', () => {
  beforeEach(() => {
    tx.note.create.mockResolvedValue({ id: 'note-x' })
  })

  it('create.data.user_id === userId', async () => {
    tx.noteKeyword.findMany.mockResolvedValue([])

    await createNote('user-1', { title: 'T', body: '', product_id: null, keywords: [] })

    const [{ data }] = tx.note.create.mock.calls[0] as [{ data: Record<string, unknown> }]
    expect(data.user_id).toBe('user-1')
  })

  it('gebruikt planKeywordResolution: een naam die een default dupliceert levert geen nieuwe rij op', async () => {
    tx.noteKeyword.findMany.mockResolvedValue([{ id: 'kw-git', name: 'git', user_id: null }])

    const result = await createNote('user-1', {
      title: 'T',
      body: '',
      product_id: null,
      keywords: [' Git '],
    })

    expect(result).toEqual({ ok: true, id: 'note-x' })
    expect(tx.noteKeyword.createMany).not.toHaveBeenCalled()
    expect(tx.noteKeywordLink.createMany).toHaveBeenCalledWith({
      data: [{ note_id: 'note-x', keyword_id: 'kw-git' }],
    })
  })

  it('nieuwe naam → createMany({ data: [{ user_id, name }], skipDuplicates: true }), daarna herlezen voor het id', async () => {
    tx.noteKeyword.findMany
      .mockResolvedValueOnce([]) // eerste read: niets bestaands matcht
      .mockResolvedValueOnce([{ id: 'kw-new', name: 'nieuwkeyword', user_id: 'user-1' }]) // herlezen

    const result = await createNote('user-1', {
      title: 'T',
      body: '',
      product_id: null,
      keywords: ['nieuwkeyword'],
    })

    expect(result).toEqual({ ok: true, id: 'note-x' })
    expect(tx.noteKeyword.createMany).toHaveBeenCalledWith({
      data: [{ user_id: 'user-1', name: 'nieuwkeyword' }],
      skipDuplicates: true,
    })
    expect(tx.noteKeywordLink.createMany).toHaveBeenCalledWith({
      data: [{ note_id: 'note-x', keyword_id: 'kw-new' }],
    })
  })

  it('resolveKeywords blijft intern: notes-data exporteert geen resolveKeywords', async () => {
    const mod = await import('../src/lib/notes-data.js')
    expect((mod as Record<string, unknown>).resolveKeywords).toBeUndefined()
  })
})

describe('Grenswaarden via de gedeelde schema\'s (spec § 2.7, § 4.2.2) — regressiewaarborg', () => {
  it('body van 20.000 codepoints (met emoji) is geldig; 20.001 ongeldig', () => {
    const okBody = '😀'.repeat(19999) + 'a' // 19999 emoji (elk 1 codepoint) + 1 = 20.000
    const tooLongBody = okBody + 'a' // 20.001

    expect(noteBodySchema.safeParse(okBody).success).toBe(true)
    expect(noteBodySchema.safeParse(tooLongBody).success).toBe(false)
  })

  it('10 keywords geldig, 11 ongeldig', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `kw${i}`)
    const eleven = Array.from({ length: 11 }, (_, i) => `kw${i}`)

    expect(noteKeywordsSchema.safeParse(ten).success).toBe(true)
    expect(noteKeywordsSchema.safeParse(eleven).success).toBe(false)
  })

  it('titel van 200 tekens geldig, 201 ongeldig', () => {
    const title200 = 'a'.repeat(200)
    const title201 = 'a'.repeat(201)

    expect(noteTitleSchema.safeParse(title200).success).toBe(true)
    expect(noteTitleSchema.safeParse(title201).success).toBe(false)
  })
})
