import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { DispatchError } from './errors.js'

export type AssertionIssuer = 'scrum4me-workers' | 'scrum4me-web'
export type DispatchAssertionKeys = { workers?: Buffer; web?: Buffer }
export type AssertionRequest = { method: string; path: string; rawBody: Buffer }
export type DispatchAssertionClaims = {
  iss: AssertionIssuer; aud: 'queue-dispatch-v1'; sub: string
  iat: number; exp: number; jti: string; method: string; path: string; body_sha256: string
  // The Idempotency-Key is bound into the signed bytes so it cannot be swapped on the wire.
  // Non-idempotent requests (every route but submit) sign, and are verified against, the empty
  // string, exactly the value their absent header decodes to.
  idem: string
}
const fail = (): never => { throw new DispatchError('DISPATCH_UNAUTHENTICATED') }
function requireKey(key: Buffer | undefined): Buffer {
  if (!key || key.length < 32) throw new DispatchError('DISPATCH_ASSERTION_KEY_INVALID')
  return key
}
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return fail()
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) return fail()
  return bytes
}

/** Server adapters must obtain userId from their own authenticated session. */
export function signDispatchAssertion(input: AssertionRequest & {
  issuer: AssertionIssuer; userId: string; jti: string; key: Buffer; now?: number; idempotencyKey: string
}): string {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const claims: DispatchAssertionClaims = {
    iss: input.issuer, aud: 'queue-dispatch-v1', sub: input.userId,
    iat: now, exp: now + 30, jti: input.jti, method: input.method, path: input.path,
    body_sha256: createHash('sha256').update(input.rawBody).digest('hex'),
    idem: input.idempotencyKey,
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${createHmac('sha256', requireKey(input.key)).update(payload).digest('base64url')}`
}

export function verifyDispatchAssertion(input: AssertionRequest & {
  assertion: string; keys: DispatchAssertionKeys; now?: number; idempotencyKey: string
}): DispatchAssertionClaims {
  if (input.assertion.length > 8192) return fail()
  const parts = input.assertion.split('.')
  if (parts.length !== 2) return fail()
  const payload = decode(parts[0]); const signature = decode(parts[1])
  if (signature.length !== 32) return fail()
  let claims: DispatchAssertionClaims
  try { claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) } catch { return fail() }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)
    || Object.keys(claims).sort().join(',') !== 'aud,body_sha256,exp,iat,idem,iss,jti,method,path,sub'
    || !['scrum4me-workers', 'scrum4me-web'].includes(claims.iss)
    || claims.aud !== 'queue-dispatch-v1'
    || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128
    || typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 128
    || typeof claims.idem !== 'string' || claims.idem.length > 255
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
    || claims.exp - claims.iat !== 30 || typeof claims.method !== 'string' || typeof claims.path !== 'string'
    || typeof claims.body_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(claims.body_sha256)) return fail()
  const key = input.keys[claims.iss === 'scrum4me-workers' ? 'workers' : 'web']
  if (!key || key.length < 32) return fail()
  const expected = createHmac('sha256', key).update(parts[0]).digest()
  if (!timingSafeEqual(expected, signature)) return fail()
  const now = input.now ?? Math.floor(Date.now() / 1000)
  // Allow a small issuer clock lead; never move an assertion's expiry forward. The received
  // Idempotency-Key must equal the signed one: an intercepted assertion replayed with a fresh key
  // (which would otherwise mint a second request) no longer verifies. An absent header decodes to
  // the empty string here, so a non-idempotent request signed with `idem:''` still matches.
  if (claims.iat > now + 5 || now >= claims.exp || claims.method !== input.method
    || claims.path !== input.path || claims.idem !== input.idempotencyKey
    || claims.body_sha256 !== createHash('sha256').update(input.rawBody).digest('hex')) return fail()
  return claims
}
