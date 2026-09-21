import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { createAttemptCredentials } from '../../src/dispatch/credentials.js'
describe('purpose-bound supervisor attempt credentials', () => {
  it('reconstructs only the same attempt/incarnation/generation/key version and separates sessions', () => {
    const key = Buffer.alloc(32, 7)
    const credentials = createAttemptCredentials({ credentialKeys: { 1: key, 2: Buffer.alloc(32, 8) }, keyVersion: 1 })
    const original = credentials.deriveAttemptCredential('attempt', 'incarnation', 1, 1)
    expect(credentials.deriveAttemptCredential('attempt', 'incarnation', 1, 1)).toBe(original)
    for (const [attempt, incarnation, generation, version] of [['other','incarnation',1,1],['attempt','other',1,1],['attempt','incarnation',2,1],['attempt','incarnation',1,2]] as const) {
      expect(credentials.deriveAttemptCredential(attempt, incarnation, generation, version)).not.toBe(original)
    }
    expect(original).not.toBe(createHmac('sha256', key).update(JSON.stringify(['dispatch-session-v1','attempt','incarnation','token',1])).digest('base64url'))
    expect(() => credentials.deriveAttemptCredential('attempt','incarnation',1,3)).toThrow('DISPATCH_FORBIDDEN')
  })
  it('refuses absent or undersized secrets', () => {
    expect(() => createAttemptCredentials({credentialKeys:{1:Buffer.alloc(16)},keyVersion:1})).toThrow()
    expect(() => createAttemptCredentials({credentialKeys:{},keyVersion:1})).toThrow()
  })
})
