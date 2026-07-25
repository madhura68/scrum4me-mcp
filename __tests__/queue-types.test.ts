import { describe, it, expect } from 'vitest'
import { requiresTaskMeta, validateTaskMeta } from '../src/queue/types.js'

describe('queue types — CLI-pariteit (s4m-queue/src/types.ts)', () => {
  it('vereist meta.task alleen voor task en review_request', () => {
    expect(requiresTaskMeta('task')).toBe(true)
    expect(requiresTaskMeta('review_request')).toBe(true)
    expect(requiresTaskMeta('info')).toBe(false)
  })
})

describe('validateTaskMeta — geport uit de CLI, met VALIDATION_ERROR-prefix', () => {
  const valid = {
    cwd: '/tmp/x',
    repo: 'https://git.example/r.git',
    objective: 'o',
    verification: 'v',
    response_format: 'rf',
  }

  it('accepteert een compleet meta.task-object en neemt optionele velden mee', () => {
    const result = validateTaskMeta({ ...valid, branch: 'feat/x', allowed_actions: ['test'] })
    expect(result).toEqual({ ...valid, branch: 'feat/x', allowed_actions: ['test'] })
  })

  it('gooit met VALIDATION_ERROR-prefix en veldnaam bij een ontbrekend verplicht veld', () => {
    const { verification: _omit, ...incomplete } = valid
    expect(() => validateTaskMeta(incomplete)).toThrowError(/^VALIDATION_ERROR: meta\.task\.verification/)
  })

  it('gooit wanneer meta.task geen object is', () => {
    expect(() => validateTaskMeta(undefined)).toThrowError(/^VALIDATION_ERROR: meta\.task is missing/)
  })

  it('laat niet-string optionele velden weg in plaats van te falen', () => {
    const result = validateTaskMeta({ ...valid, branch: 42 })
    expect(result).toEqual(valid)
  })
})
