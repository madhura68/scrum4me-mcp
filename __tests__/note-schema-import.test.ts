// __tests__/note-schema-import.test.ts
// Rooktest (IDEA-226, T-149): het gedeelde notes-contract is via @shared bereikbaar
// en het bodycontract klopt als data — lijstvelden zonder body, detail mét body.
import { describe, it, expect } from 'vitest'
import {
  NOTE_LIST_FIELDS,
  NOTE_DETAIL_FIELDS,
  NOTE_LIST_ORDER,
  countBodyChars,
  noteCreateSchema,
} from '@shared/note-schema.js'

describe('@shared/note-schema import', () => {
  it('NOTE_LIST_FIELDS bevat geen body, NOTE_DETAIL_FIELDS wel', () => {
    expect(NOTE_LIST_FIELDS).not.toContain('body')
    expect(NOTE_DETAIL_FIELDS).toContain('body')
  })

  it('ordering is updated_at DESC, id DESC', () => {
    expect(NOTE_LIST_ORDER).toEqual([{ updated_at: 'desc' }, { id: 'desc' }])
  })

  it('telt codepoints en valideert een minimale note', () => {
    expect(countBodyChars('😀ab')).toBe(3)
    expect(noteCreateSchema.safeParse({ title: 'x' }).success).toBe(true)
  })
})
