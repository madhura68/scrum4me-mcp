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
})
