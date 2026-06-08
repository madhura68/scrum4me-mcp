import { describe, it, expect } from 'vitest'
import { classifyCodexOutput } from '../../src/lib/codex-output.js'

describe('classifyCodexOutput', () => {
  it('returns both false for clean output', () => {
    const text = '{"type":"item.completed","item":{"text":"done"}}\n{"type":"turn.completed"}'
    expect(classifyCodexOutput(text)).toEqual({ tokenExpired: false, apiOverloaded: false })
  })

  it('flags tokenExpired on a 401/unauthorized error event', () => {
    const text = '{"type":"turn.failed","error":{"message":"401 Unauthorized: token expired"}}'
    expect(classifyCodexOutput(text)).toEqual({ tokenExpired: true, apiOverloaded: false })
  })

  it('flags tokenExpired when codex asks the user to log in', () => {
    const text = '{"type":"error","message":"Not logged in. Please run codex login."}'
    expect(classifyCodexOutput(text).tokenExpired).toBe(true)
  })

  it('flags apiOverloaded on a 429/rate-limit error event', () => {
    const text = '{"type":"turn.failed","error":{"message":"429 rate limit exceeded"}}'
    expect(classifyCodexOutput(text)).toEqual({ tokenExpired: false, apiOverloaded: true })
  })

  it('prefers tokenExpired when both auth and overload markers are present', () => {
    const text = '{"type":"error","message":"401 unauthorized and overloaded 429"}'
    expect(classifyCodexOutput(text)).toEqual({ tokenExpired: true, apiOverloaded: false })
  })

  it('falls back to scanning raw text when there is no parseable error event', () => {
    expect(classifyCodexOutput('plain stderr: 401 Unauthorized').tokenExpired).toBe(true)
  })
})
