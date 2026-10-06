import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@shared/agent-runtime.js'
import {
  getWorkerRuntimeFromEnv,
  parseWorkerRuntime,
  type WorkerRuntime,
} from '../src/worker-runtime.js'

// Compile-time pin (alleen `npm run typecheck:tests` ziet dit): WorkerRuntime ÍS de
// gedeelde AgentRuntime, niet een eigen lijst die naast de enum kan wegdrijven.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const workerRuntimeIsAgentRuntime: Equal<WorkerRuntime, AgentRuntime> = true
void workerRuntimeIsAgentRuntime

// De melding is exact de code: de waarde zelf mag er niet in (hij kan uit een
// omgevingsvariabele komen), en een code die er nog iets achter plakt breekt de
// `message === code`-afspraak van de resolver in scrum4me-shared.
function thrownMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return '(geen fout gegooid)'
}

describe('parseWorkerRuntime', () => {
  it.each([
    ['CLAUDE', 'CLAUDE'],
    ['claude', 'CLAUDE'],
    [' claude ', 'CLAUDE'],
    ['CODEX', 'CODEX'],
    ['codex', 'CODEX'],
    [' Codex\n', 'CODEX'],
    ['HARNESS', 'HARNESS'],
    ['harness', 'HARNESS'],
    ['Harness', 'HARNESS'],
    [' harness ', 'HARNESS'],
  ] as const)('geeft voor %j de runtime %s', (input, expected) => {
    expect(parseWorkerRuntime(input)).toBe(expected)
  })

  it.each(['', '   ', undefined, null])(
    'een ontbrekende waarde (%j) is de gedocumenteerde standaard CLAUDE',
    (input) => {
      expect(parseWorkerRuntime(input)).toBe('CLAUDE')
    },
  )

  it.each([
    'gpt-5',
    'bogus',
    'CODE X',
    'HARNESS2',
    'harnes',
    'claude codex',
    'claude,codex',
    // Wat een sjabloon of een shell van een ontbrekende waarde maakt: nooit stil CLAUDE.
    'null',
    'undefined',
    '0',
  ])('weigert de onbekende waarde %j met UNKNOWN_AGENT_RUNTIME', (input) => {
    expect(thrownMessage(() => parseWorkerRuntime(input))).toBe('UNKNOWN_AGENT_RUNTIME')
  })
})

describe('getWorkerRuntimeFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('leest SCRUM4ME_WORKER_RUNTIME uit de meegegeven env', () => {
    expect(getWorkerRuntimeFromEnv({ SCRUM4ME_WORKER_RUNTIME: 'harness' })).toBe('HARNESS')
    expect(getWorkerRuntimeFromEnv({ SCRUM4ME_WORKER_RUNTIME: 'CODEX' })).toBe('CODEX')
    expect(getWorkerRuntimeFromEnv({ SCRUM4ME_WORKER_RUNTIME: 'CLAUDE' })).toBe('CLAUDE')
  })

  it('zonder variabele is de standaard CLAUDE', () => {
    expect(getWorkerRuntimeFromEnv({})).toBe('CLAUDE')
    expect(getWorkerRuntimeFromEnv({ SCRUM4ME_WORKER_RUNTIME: '' })).toBe('CLAUDE')
  })

  it('weigert een onbekende waarde met UNKNOWN_AGENT_RUNTIME', () => {
    expect(thrownMessage(() => getWorkerRuntimeFromEnv({ SCRUM4ME_WORKER_RUNTIME: 'bogus' }))).toBe(
      'UNKNOWN_AGENT_RUNTIME',
    )
  })

  it('leest process.env als er geen env wordt meegegeven (signatuur ongewijzigd)', () => {
    vi.stubEnv('SCRUM4ME_WORKER_RUNTIME', ' harness ')
    expect(getWorkerRuntimeFromEnv()).toBe('HARNESS')
    vi.stubEnv('SCRUM4ME_WORKER_RUNTIME', 'bogus')
    expect(thrownMessage(() => getWorkerRuntimeFromEnv())).toBe('UNKNOWN_AGENT_RUNTIME')
  })
})
