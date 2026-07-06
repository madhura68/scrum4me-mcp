import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { isStoryAutoMergeCandidate } from '../src/tools/update-job-status.js'

// M17 E2E-bevinding #7: de STORY-auto-merge-gate moet LEVEL-triggered zijn.
// De oude gate hing aan propagateStatusUpwards().storyChanged (edge): omdat de
// agent binnen de job zelf de taak op done zet, was de story al DONE vóórdat
// update_job_status draaide — edge verbruikt, blok geskipt, geen auto-merge en
// geen DEPLOY-enqueue (T-1387/PR #110, 2026-07-06).

const T1387_SCENARIO = {
  // Exact het scenario waarin de oude edge-gate faalde: alle statische
  // condities vervuld; de story was al DONE vóór de call (geen edge meer).
  actualStatus: 'done',
  prUrl: 'https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/110',
  headSha: 'b290272a2549b1c8de09a93ebf0ebfac7a0a0fe1',
  kind: 'TASK_IMPLEMENTATION',
  source: 'SYSTEM',
  taskId: 'cmr9howky000kgw17zc0caj12',
}

describe('isStoryAutoMergeCandidate (level-triggered gate, bevinding #7)', () => {
  it('T-1387-scenario is kandidaat — ook zonder story-DONE-edge in deze call', () => {
    expect(isStoryAutoMergeCandidate(T1387_SCENARIO)).toBe(true)
  })

  it('truth-table: elke ontbrekende conditie maakt de gate false', () => {
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, actualStatus: 'failed' })).toBe(false)
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, actualStatus: 'skipped' })).toBe(false)
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, prUrl: null })).toBe(false)
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, prUrl: undefined })).toBe(false)
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, headSha: null })).toBe(false)
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, kind: 'SPRINT_IMPLEMENTATION' })).toBe(false)
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, kind: 'DEPLOY' })).toBe(false)
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, source: 'MANUAL' })).toBe(false)
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, taskId: null })).toBe(false)
  })

  it('COPILOT-source is wél kandidaat (standalone taken met PR + head_sha)', () => {
    expect(isStoryAutoMergeCandidate({ ...T1387_SCENARIO, source: 'COPILOT' })).toBe(true)
  })
})

describe('handler-bron gebruikt de level-gate (drift-guard)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/tools/update-job-status.ts'),
    'utf-8',
  )

  it('het auto-merge-blok roept isStoryAutoMergeCandidate aan', () => {
    // Definitie + minstens één aanroep in de handler.
    const hits = src.match(/isStoryAutoMergeCandidate/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it('de edge-variabele storyBecameDone bestaat niet meer (regressie-guard)', () => {
    // Her-invoeren van een storyChanged/storyBecameDone-afhankelijkheid voor
    // de auto-merge-gate is exact de bug van bevinding #7.
    expect(src).not.toMatch(/storyBecameDone/)
  })
})
