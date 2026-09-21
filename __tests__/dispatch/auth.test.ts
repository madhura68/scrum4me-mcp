import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signDispatchAssertion, verifyDispatchAssertion } from '../../src/dispatch/assertions.js'

const key = Buffer.alloc(32, 7)
const keys = { workers: key, web: Buffer.alloc(32, 8) }
const request = { method: 'POST', path: '/dispatch/v1/requests', rawBody: Buffer.from('{"objective":"é"}') }
const idempotencyKey = 'submit-key-1'
const claims = { issuer: 'scrum4me-workers' as const, userId: 'user-1', jti: 'action-1', now: 1000, idempotencyKey }
const signed = () => signDispatchAssertion({ ...claims, ...request, key, idempotencyKey })
const verify = (assertion: string, change = {}) => verifyDispatchAssertion({ assertion, ...request, keys, now: 1000, idempotencyKey, ...change })

describe('dispatch assertion boundary', () => {
  it('binds issuer, user and exact request bytes', () => {
    expect(verify(signed())).toMatchObject({ sub: 'user-1', iss: 'scrum4me-workers', exp: 1030 })
    expect(() => verify(signed(), { rawBody: Buffer.from('{ "objective":"é"}') })).toThrow('DISPATCH_UNAUTHENTICATED')
    expect(() => verify(signed(), { method: 'GET' })).toThrow('DISPATCH_UNAUTHENTICATED')
    expect(() => verify(signed(), { path: '/dispatch/v1/profiles' })).toThrow('DISPATCH_UNAUTHENTICATED')
  })
  it('binds the Idempotency-Key: a replay with a different or absent key is refused', () => {
    // The signed value round-trips when the header matches.
    expect(verify(signed())).toMatchObject({ idem: idempotencyKey })
    // Same signed assertion, a fresh Idempotency-Key on the wire — the replay the MINOR describes.
    expect(() => verify(signed(), { idempotencyKey: 'second-key' })).toThrow('DISPATCH_UNAUTHENTICATED')
    expect(() => verify(signed(), { idempotencyKey: '' })).toThrow('DISPATCH_UNAUTHENTICATED')
    // A non-idempotent request signs the empty string and matches its absent header.
    const noKey = signDispatchAssertion({ ...claims, ...request, key, idempotencyKey: '' })
    expect(verify(noKey, { idempotencyKey: '' })).toMatchObject({ idem: '' })
    expect(() => verify(noKey, { idempotencyKey: 'sneaked-in' })).toThrow('DISPATCH_UNAUTHENTICATED')
  })
  it('accepts at most five seconds future clock skew and never extends expiry', () => {
    expect(() => verify(signed(), { now: 995 })).not.toThrow()
    expect(() => verify(signed(), { now: 994 })).toThrow('DISPATCH_UNAUTHENTICATED')
    expect(() => verify(signed(), { now: 1029 })).not.toThrow()
    expect(() => verify(signed(), { now: 1030 })).toThrow('DISPATCH_UNAUTHENTICATED')
  })
  it.each(['', 'a.b', '!!!!.!!!!', 'e30=.abc', 'e30.' + 'a'.repeat(43), 'e30.'])('rejects malformed assertion %s', assertion => {
    expect(() => verify(assertion)).toThrow('DISPATCH_UNAUTHENTICATED')
  })
  it('rejects validly signed lifetime extensions, unknown issuers and wrong issuer key', () => {
    const [payload] = signed().split('.')
    for (const patch of [{ exp: 1100 }, { iss: 'other' }, { aud: 'mcp' }, { iat: 1000.5 }, { body_sha256: { toString: null } }]) {
      const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), ...patch })).toString('base64url')
      const signature = createHmac('sha256', key).update(bytes).digest('base64url')
      expect(() => verify(`${bytes}.${signature}`)).toThrow('DISPATCH_UNAUTHENTICATED')
    }
    expect(() => verify(signDispatchAssertion({ ...claims, ...request, issuer: 'scrum4me-web', key }))).toThrow('DISPATCH_UNAUTHENTICATED')
  })
  it('requires independent keys with at least 32 bytes', () => {
    expect(() => signDispatchAssertion({ ...claims, ...request, key: Buffer.alloc(31) })).toThrow('DISPATCH_ASSERTION_KEY_INVALID')
  })
})
