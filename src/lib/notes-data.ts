// Data-access-adapter voor notes (IDEA-226, PBI-30, T-150). Enige plek die
// `prisma.note*` aanraakt — MCP-tools praten nooit rechtstreeks met de
// Prisma-client voor notes (spec § 4.2.3).
//
// Privacygrens (spec § 4.1): notes zijn op GEBRUIKER gescoped, niet op
// product. Elke query hieronder bevat `user_id`. Een niet-gevonden note en
// andermans note geven hetzelfde resultaat (404 / `null` / `count === 0`) —
// nooit 403, dat zou bestaan verraden. Hetzelfde geldt voor een
// niet-toegankelijk product bij create/update: 404 "Product niet gevonden",
// ongeacht of het product bestaat.
//
// Pariteitsmodel: Scrum4Me `lib/notes-server.ts`. Afwijking t.o.v. web (bewust,
// spec § 2.5): `listNotes` met een `productId`-filter buiten de tokenscope of
// -toegang geeft "Product niet gevonden" i.p.v. het filter te negeren — een
// product buiten de tokenscope mag hier niet eens als filter bruikbaar zijn.
// De productcheck gaat via `userCanAccessProduct` (`src/access.ts`), die
// `scoped_products` van het token al afdwingt (i.p.v. web's
// `productAccessFilter`).
//
// Bodycontract (spec § 4.4): `body` staat nooit in de `select` van een
// lijst-query — alleen `getNote` levert de body. `NOTE_LIST_FIELDS` bevat
// geen `body`; de selects hieronder zijn daaruit opgebouwd, niet los getypt.
//
// Spec: `.superpowers/idea-226-spec.md` (Scrum4Me-repo) § 2.5, § 2.5.1, § 4.1,
// § 4.2.3, § 4.3, § 4.4.

import { Prisma } from '@prisma/client'

import { prisma } from '../prisma.js'
import { userCanAccessProduct } from '../access.js'
import {
  NOTE_LIST_FIELDS,
  NOTE_DETAIL_FIELDS,
  NOTE_LIST_ORDER,
  normalizeKeyword,
  normalizeKeywordList,
  planKeywordResolution,
} from '@shared/note-schema.js'
import type { NoteCreateInput, NoteUpdateInput } from '@shared/note-schema.js'

// ---------------------------------------------------------------------------
// Selects — opgebouwd uit de veldcontracten in `@shared/note-schema`, geen
// losse veldnamen in de querycode (spec § 4.2.3).
// ---------------------------------------------------------------------------

const noteListFieldsSelect = Object.fromEntries(
  NOTE_LIST_FIELDS.map((field) => [field, true] as const),
) as Record<(typeof NOTE_LIST_FIELDS)[number], true>

const noteDetailFieldsSelect = Object.fromEntries(
  NOTE_DETAIL_FIELDS.map((field) => [field, true] as const),
) as Record<(typeof NOTE_DETAIL_FIELDS)[number], true>

const noteRelationsSelect = {
  product: { select: { id: true, name: true } },
  keywords: { select: { keyword: { select: { id: true, name: true, user_id: true } } } },
} satisfies Prisma.NoteSelect

const noteListSelect = { ...noteListFieldsSelect, ...noteRelationsSelect } satisfies Prisma.NoteSelect
const noteDetailSelect = { ...noteDetailFieldsSelect, ...noteRelationsSelect } satisfies Prisma.NoteSelect

export type NoteListItem = Prisma.NoteGetPayload<{ select: typeof noteListSelect }>
export type NoteDetail = Prisma.NoteGetPayload<{ select: typeof noteDetailSelect }>

// ---------------------------------------------------------------------------
// Foutuitkomsten (spec § 4.1)
// ---------------------------------------------------------------------------

export interface NoteError {
  ok: false
  code: 404
  error: string
}

const PRODUCT_NOT_FOUND: NoteError = { ok: false, code: 404, error: 'Product niet gevonden' }
const NOTE_NOT_FOUND: NoteError = { ok: false, code: 404, error: 'Note niet gevonden' }

// ---------------------------------------------------------------------------
// listNotes / getNote
// ---------------------------------------------------------------------------

export interface ListNotesFilters {
  q?: string
  productId?: string
  keyword?: string
  limit: number
  offset: number
}

export interface ListNotesResult {
  ok: true
  items: NoteListItem[]
  total: number
  limit: number
  offset: number
  has_more: boolean
}

export type ListNotesOutcome = ListNotesResult | NoteError

export async function listNotes(userId: string, filters: ListNotesFilters): Promise<ListNotesOutcome> {
  const { q, productId, keyword, limit, offset } = filters

  // MCP-afwijking van web (spec § 2.5): een product buiten de tokenscope of
  // -toegang is niet bruikbaar als filter — geen stille "negeer het filter",
  // en geen query op `note` vooraf.
  if (productId && !(await userCanAccessProduct(productId, userId))) {
    return PRODUCT_NOT_FOUND
  }

  const where: Prisma.NoteWhereInput = {
    user_id: userId,
    ...(q && {
      OR: [
        { title: { contains: q, mode: 'insensitive' as const } },
        { body: { contains: q, mode: 'insensitive' as const } },
      ],
    }),
    ...(productId && { product_id: productId }),
    ...(keyword && {
      keywords: {
        some: {
          keyword: {
            name: normalizeKeyword(keyword),
            OR: [{ user_id: null }, { user_id: userId }],
          },
        },
      },
    }),
  }

  const [items, total] = await prisma.$transaction([
    prisma.note.findMany({
      where,
      select: noteListSelect,
      orderBy: [...NOTE_LIST_ORDER],
      skip: offset,
      take: limit,
    }),
    prisma.note.count({ where }),
  ])

  return { ok: true, items, total, limit, offset, has_more: offset + items.length < total }
}

export async function getNote(userId: string, id: string): Promise<NoteDetail | null> {
  return prisma.note.findFirst({
    where: { id, user_id: userId },
    select: noteDetailSelect,
  })
}

// ---------------------------------------------------------------------------
// listKeywords
// ---------------------------------------------------------------------------

export interface NoteKeywordItem {
  id: string
  name: string
  is_default: boolean
}

export async function listKeywords(userId: string): Promise<NoteKeywordItem[]> {
  const rows = await prisma.noteKeyword.findMany({
    where: { OR: [{ user_id: null }, { user_id: userId }] },
    select: { id: true, name: true, user_id: true },
  })

  // Sortering gebeurt in JS, niet via Prisma `orderBy`: "defaults eerst" is een
  // NULLS FIRST op `user_id` die niet portabel via Prisma uit te drukken is
  // zonder raw SQL. Binnen elke groep alfabetisch op naam.
  return rows
    .map((row) => ({ id: row.id, name: row.name, is_default: row.user_id === null }))
    .sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

// ---------------------------------------------------------------------------
// resolveKeywords — niet exported (repo-lokaal, spec § 4.2.3). Normaliseert de
// namen, matcht ze tegen defaults + eigen keywords van de gebruiker, en maakt
// alleen het ontbrekende aan. `skipDuplicates` (ON CONFLICT DO NOTHING) i.p.v.
// een P2002 vangen: één mislukt statement breekt in Postgres de hele
// transactie af (spec § 4.3).
// ---------------------------------------------------------------------------

async function resolveKeywords(
  tx: Prisma.TransactionClient,
  userId: string,
  names: string[],
): Promise<string[]> {
  const normalized = normalizeKeywordList(names)
  if (normalized.length === 0) return []

  const existing = await tx.noteKeyword.findMany({
    where: { name: { in: normalized }, OR: [{ user_id: null }, { user_id: userId }] },
    select: { id: true, name: true, user_id: true },
  })

  const { linkKeywordIds, missingNames } = planKeywordResolution(userId, normalized, existing)
  if (missingNames.length === 0) return linkKeywordIds

  await tx.noteKeyword.createMany({
    data: missingNames.map((name) => ({ user_id: userId, name })),
    skipDuplicates: true,
  })

  // Opnieuw lezen i.p.v. de net aangemaakte ids aannemen: een gelijktijdige
  // dubbele insert (zelfde gebruiker, twee requests) is opgevangen door
  // `skipDuplicates` en moet hier de winnende rij oppikken.
  const created = await tx.noteKeyword.findMany({
    where: { name: { in: missingNames }, OR: [{ user_id: null }, { user_id: userId }] },
    select: { id: true, name: true, user_id: true },
  })
  const { linkKeywordIds: createdIds } = planKeywordResolution(userId, missingNames, created)

  return [...linkKeywordIds, ...createdIds]
}

// ---------------------------------------------------------------------------
// createNote / updateNote / deleteNote
// ---------------------------------------------------------------------------

export type CreateNoteResult = { ok: true; id: string } | NoteError

export async function createNote(userId: string, input: NoteCreateInput): Promise<CreateNoteResult> {
  if (input.product_id && !(await userCanAccessProduct(input.product_id, userId))) {
    return PRODUCT_NOT_FOUND
  }

  const id = await prisma.$transaction(async (tx) => {
    const note = await tx.note.create({
      data: {
        user_id: userId,
        title: input.title,
        body: input.body,
        product_id: input.product_id ?? null,
      } satisfies Prisma.NoteUncheckedCreateInput,
      select: { id: true },
    })

    const keywordIds = await resolveKeywords(tx, userId, input.keywords)
    if (keywordIds.length > 0) {
      await tx.noteKeywordLink.createMany({
        data: keywordIds.map((keyword_id) => ({ note_id: note.id, keyword_id })),
      })
    }

    return note.id
  })

  return { ok: true, id }
}

export type UpdateNoteResult = { ok: true } | NoteError

// Sentinel om de transactie bewust te laten falen op een count-mismatch (zie
// hieronder) — nooit naar buiten toe zichtbaar, alleen intern gevangen.
class NoteUpdateNotFoundError extends Error {}

export async function updateNote(
  userId: string,
  id: string,
  patch: NoteUpdateInput,
): Promise<UpdateNoteResult> {
  if (patch.product_id && !(await userCanAccessProduct(patch.product_id, userId))) {
    return PRODUCT_NOT_FOUND
  }

  try {
    return await prisma.$transaction(async (tx): Promise<UpdateNoteResult> => {
      // Weggelaten velden blijven ongewijzigd; `updated_at` bumpt altijd, ook als
      // alleen de keywords wijzigen (spec § 2.5.1).
      const data: Prisma.NoteUncheckedUpdateInput = { updated_at: new Date() }
      if (patch.title !== undefined) data.title = patch.title
      if (patch.body !== undefined) data.body = patch.body
      if (patch.product_id !== undefined) data.product_id = patch.product_id

      // De schrijfactie zelf draagt de scope (`updateMany` i.p.v. `update` op
      // een losse ownership-`findFirst`): een note die tussen een eerdere check
      // en hier concurrent verwijderd (of van eigenaar gewisseld) is, geeft hier
      // `count === 0` i.p.v. dat `update({ where: { id } })` P2025 gooit en de
      // caller een 500 in plaats van een 404 ziet.
      //
      // `count !== 1` moet de transactie laten ROLLBACKen, niet stil `return`en:
      // een niet-string `id` die de tool-laag ooit zou missen (bv. `{ not: '' }`)
      // kan deze `updateMany` op meerdere rijen tegelijk laten matchen. Een
      // `return` uit deze callback laat Prisma de transactie gewoon COMMITten —
      // de title/body-overschrijving op die rijen zou dan blijven staan terwijl
      // de caller "niet gevonden" te horen krijgt. Alleen een `throw` breekt de
      // transactie af.
      const { count } = await tx.note.updateMany({ where: { id, user_id: userId }, data })
      if (count !== 1) throw new NoteUpdateNotFoundError()

      if (patch.keywords !== undefined) {
        // Alleen bereikbaar ná de scoped `updateMany` hierboven: de link-delete
        // en -relink gelden dus altijd voor een note die net binnen déze
        // transactie als van `userId` bevestigd is.
        await tx.noteKeywordLink.deleteMany({ where: { note_id: id } })
        const keywordIds = await resolveKeywords(tx, userId, patch.keywords)
        if (keywordIds.length > 0) {
          await tx.noteKeywordLink.createMany({
            data: keywordIds.map((keyword_id) => ({ note_id: id, keyword_id })),
          })
        }
      }

      return { ok: true }
    })
  } catch (err) {
    if (err instanceof NoteUpdateNotFoundError) return NOTE_NOT_FOUND
    throw err
  }
}

export async function deleteNote(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.note.deleteMany({ where: { id, user_id: userId } })
  return count === 1
}
