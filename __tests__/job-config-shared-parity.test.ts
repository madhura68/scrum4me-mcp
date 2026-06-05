import { describe, it, expect } from 'vitest'
import { getKindDefault as mcpGetKindDefault } from '../src/lib/job-config.js'
import { getKindDefault as sharedGetKindDefault } from '@shared/job-config.js'

// P0-A drift-guard. mcp's job-config (the RUNTIME source — wait-for-job →
// payload → run-one-job.ts --allowedTools) and @shared/job-config (the source
// workers imports for its launch-preview/snapshot DISPLAY) are mirrored copies.
//
// Until @shared is a buildable package that mcp can compile + re-export
// (separate platform-split infra task — mcp runs `node dist`, @shared ships as
// TS source), this test enforces the two stay byte-equal per kind, so the
// workers editor never shows a config the worker doesn't actually run.
//
// This test imports @shared and therefore lives in __tests__ (never compiled
// into dist), so it does not affect the deployed `node dist/http.js` build.
const KINDS = [
  'IDEA_GRILL',
  'IDEA_MAKE_PLAN',
  'IDEA_REVIEW_PLAN',
  'PLAN_CHAT',
  'TASK_IMPLEMENTATION',
  'SPRINT_IMPLEMENTATION',
]

describe('job-config parity: mcp runtime == @shared display', () => {
  it.each(KINDS)('%s resolves identically in mcp and @shared', (kind) => {
    expect(mcpGetKindDefault(kind)).toEqual(sharedGetKindDefault(kind))
  })

  it('FALLBACK (unknown kind) is identical', () => {
    expect(mcpGetKindDefault('__nonexistent_kind__')).toEqual(
      sharedGetKindDefault('__nonexistent_kind__'),
    )
  })
})
