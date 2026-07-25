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

  it('weigert null net zo hard als undefined', () => {
    // Zonder deze assertie mag de `!task ||`-helft van de guard verdwijnen en
    // gooit validateTaskMeta(null) een TypeError in plaats van de getypeerde
    // fout. meta.task komt uit agent-JSON, dus null is realistisch.
    expect(() => validateTaskMeta(null)).toThrowError(/^VALIDATION_ERROR: meta\.task is missing/)
  })

  it('weigert elk verplicht veld afzonderlijk wanneer het ontbreekt', () => {
    // Eén negatieve test bewijst geen lijst van vijf: met alleen de
    // verification-case mocht response_format er ongestraft uit.
    for (const key of ['cwd', 'repo', 'objective', 'verification', 'response_format'] as const) {
      const { [key]: _omit, ...incomplete } = valid
      expect(() => validateTaskMeta(incomplete), `ontbrekend veld ${key}`)
        .toThrowError(new RegExp(`^VALIDATION_ERROR: meta\\.task\\.${key}`))
    }
  })

  it('weigert een verplicht veld dat leeg of alleen witruimte is', () => {
    // De .trim()-helft van de guard was ongedekt: '   ' werd geaccepteerd en
    // belandde als lege cwd in de meta-kolom.
    expect(() => validateTaskMeta({ ...valid, cwd: '   ' }))
      .toThrowError(/^VALIDATION_ERROR: meta\.task\.cwd/)
    expect(() => validateTaskMeta({ ...valid, objective: '' }))
      .toThrowError(/^VALIDATION_ERROR: meta\.task\.objective/)
  })

  it('weigert een verplicht veld dat geen string is', () => {
    // Ongedekt: een number kwam er zo doorheen en bereikt een worker als cwd.
    expect(() => validateTaskMeta({ ...valid, cwd: 42 }))
      .toThrowError(/^VALIDATION_ERROR: meta\.task\.cwd/)
  })

  it('neemt worktree en expected_result mee, net als branch', () => {
    // Alleen branch had dekking; deze twee mochten stilletjes verdwijnen.
    const result = validateTaskMeta({ ...valid, worktree: '/wt', expected_result: 'er' })
    expect(result).toEqual({ ...valid, worktree: '/wt', expected_result: 'er' })
  })

  it('houdt allowed_actions alleen als élk element een string is', () => {
    // .every is vacuously true op een lege array, dus die blijft staan. Een
    // gemengde array wordt in z'n geheel weggelaten, niet gefilterd.
    expect(validateTaskMeta({ ...valid, allowed_actions: [] }))
      .toEqual({ ...valid, allowed_actions: [] })
    expect(validateTaskMeta({ ...valid, allowed_actions: ['ok', 1] })).toEqual(valid)
    expect(validateTaskMeta({ ...valid, allowed_actions: 'test' })).toEqual(valid)
  })
})
