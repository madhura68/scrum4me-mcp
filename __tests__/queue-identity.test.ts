import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseQueueTarget, resolveQueueIdentity } from '../src/queue/identity.js'

beforeEach(() => {
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
})
afterEach(() => vi.unstubAllEnvs())

describe('resolveQueueIdentity — spec §3', () => {
  it('leest (S4M_SERVER, S4M_MODEL) uit env', () => {
    expect(resolveQueueIdentity()).toEqual({ server: 'mac', model: 'claude' })
  })

  it("laat 'as' alleen het model overriden", () => {
    expect(resolveQueueIdentity('codex')).toEqual({ server: 'mac', model: 'codex' })
  })

  it('gooit QUEUE_IDENTITY_REQUIRED zonder S4M_SERVER', () => {
    vi.stubEnv('S4M_SERVER', '')
    expect(() => resolveQueueIdentity()).toThrowError(/^QUEUE_IDENTITY_REQUIRED: S4M_SERVER/)
  })

  it('gooit QUEUE_IDENTITY_REQUIRED zonder S4M_MODEL en zonder as', () => {
    vi.stubEnv('S4M_MODEL', '')
    expect(() => resolveQueueIdentity()).toThrowError(/^QUEUE_IDENTITY_REQUIRED: S4M_MODEL/)
  })

  it('weigert een onbekende servernaam', () => {
    vi.stubEnv('S4M_SERVER', 'laptop')
    expect(() => resolveQueueIdentity()).toThrowError(/^QUEUE_IDENTITY_REQUIRED/)
  })

  it('weigert een onbekende as-waarde', () => {
    expect(() => resolveQueueIdentity('gpt')).toThrowError(/^QUEUE_IDENTITY_REQUIRED/)
  })

  it('trimt witruimte rond de env-waarden', () => {
    // Zonder deze assertie mag .trim() uit de server-read verdwijnen; een
    // env-bestand met een spatie achter de waarde levert dan een adres op dat
    // nergens op matcht.
    vi.stubEnv('S4M_SERVER', '  mac  ')
    vi.stubEnv('S4M_MODEL', ' claude ')
    expect(resolveQueueIdentity()).toEqual({ server: 'mac', model: 'claude' })
  })

  it("weigert een lege as-waarde in plaats van terug te vallen op de env", () => {
    // ?? valt alleen terug bij null/undefined, dus '' hoort dóór te lopen naar
    // de membership-check en te falen. Met || zou hij stilletjes het
    // env-model pakken en het bericht onder de verkeerde identiteit versturen.
    expect(() => resolveQueueIdentity('')).toThrowError(/^QUEUE_IDENTITY_REQUIRED: S4M_MODEL/)
  })

  it('noemt de aangeboden waarde in de foutmelding, niet een andere variabele', () => {
    // De regexen hierboven ankeren alleen op het prefix; de (was: ...)-staart
    // was volledig ongedekt en mocht dus de servernaam tonen bij een
    // model-fout.
    expect(() => resolveQueueIdentity('gpt')).toThrowError(/\(was: gpt\)/)
    vi.stubEnv('S4M_SERVER', 'laptop')
    expect(() => resolveQueueIdentity()).toThrowError(/\(was: laptop\)/)
  })
})

describe('parseQueueTarget — CLI-pariteit (parseTarget)', () => {
  it('parseert <server>:<model>', () => {
    expect(parseQueueTarget('scrum4me-server:claude')).toEqual({ server: 'scrum4me-server', model: 'claude' })
    expect(parseQueueTarget('mac:jp')).toEqual({ server: 'mac', model: 'jp' })
  })

  it('weigert onbekende combinaties met VALIDATION_ERROR', () => {
    expect(() => parseQueueTarget('mars:claude')).toThrowError(/^VALIDATION_ERROR: invalid target/)
    expect(() => parseQueueTarget('mac')).toThrowError(/^VALIDATION_ERROR/)
    expect(() => parseQueueTarget('mac:claude:extra')).toThrowError(/^VALIDATION_ERROR/)
  })

  it('weigert een doel met een lege helft', () => {
    // ':claude'.split(':') geeft ['', 'claude'] — lengte 2, dus de lengtecheck
    // laat hem door. Alleen de membership-check vangt hem, en die was op dit
    // punt ongedekt.
    expect(() => parseQueueTarget(':claude')).toThrowError(/^VALIDATION_ERROR/)
    expect(() => parseQueueTarget('mac:')).toThrowError(/^VALIDATION_ERROR/)
    expect(() => parseQueueTarget('')).toThrowError(/^VALIDATION_ERROR/)
  })
})
