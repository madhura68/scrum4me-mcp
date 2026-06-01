import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'

import { buildHigherTierIdleFragment } from '../src/tools/wait-for-job.js'

function sqlText(fragment: Prisma.Sql): string {
  return fragment.strings.join('?').replace(/\s+/g, ' ').trim()
}

describe('buildHigherTierIdleFragment', () => {
  it('emits NOT EXISTS guarded by higher capability, alive, idle, quota', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'MEDIUM_P',
    })
    const text = sqlText(frag)
    expect(text).toMatch(/AND NOT EXISTS/i)
    expect(text).toMatch(/FROM claude_workers w/i)
    expect(text).toMatch(/w\.runtime\s*=\s*\?::"AgentRuntime"/i)
    expect(text).toMatch(/w\.instance_id\s*<>\s*\?/i)
    expect(text).toMatch(/w\.capability\s*>\s*\?::"WorkerCapability"/i)
    expect(text).toMatch(/w\.last_seen_at\s*>\s*NOW\(\)\s*-\s*INTERVAL\s*'30 seconds'/i)
    expect(text).toMatch(/w\.last_quota_pct IS NULL OR w\.last_quota_pct >=/i)
    expect(text).toMatch(/k\.worker_instance_id\s*=\s*w\.instance_id/i)
    expect(text).toMatch(/k\.status IN \('CLAIMED','RUNNING'\)/i)
  })

  it('binds the right values in order: userId, runtime, instanceId, capability', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'MEDIUM_P',
    })
    expect(frag.values).toEqual(['u1', 'CLAUDE', 'i1', 'MEDIUM_P'])
  })

  it('passes null capability through (legacy worker semantics: no blocking)', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: null,
    })
    expect(frag.values).toEqual(['u1', 'CLAUDE', 'i1', null])
  })
})
