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
    expect(text).toMatch(/CASE w\.capability\s+WHEN 'HIGH_P' THEN 3\s+WHEN 'MEDIUM_P' THEN 2\s+WHEN 'LOW_P' THEN 1\s+END/i)
    expect(text).toMatch(/CASE \?::"WorkerCapability"\s+WHEN 'HIGH_P' THEN 3\s+WHEN 'MEDIUM_P' THEN 2\s+WHEN 'LOW_P' THEN 1\s+END/i)
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

describe('claimability-guard (regression voor de M17 tier-deadlock, 2026-07-04)', () => {
  // Deadlock-scenario: dedicated deploy-worker (LOW_P) defereerde eeuwig naar
  // idle HIGH_P-workers zonder 'deploy'-capability; de DEPLOY-job bleef QUEUED.
  // De guard laat een hogere-tier peer alleen meetellen als die de kandidaat-
  // job (cj) zelf zou kunnen claimen.
  const frag = () =>
    buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'LOW_P',
    })

  it('correleert de peer-claimbaarheid met de kandidaat-job (generiek pad)', () => {
    const text = sqlText(frag())
    // Zonder dit predicaat blokkeert een capability-loze HIGH_P-peer een
    // deploy-job die hij nooit kan claimen — de exacte deadlock.
    expect(text).toMatch(
      /cj\.required_capability IS NULL\s+OR cj\.required_capability = ANY\(w\.capabilities\)/i
    )
  })

  it('spiegelt het deployOnly-claimpad voor exact-[deploy]-peers (spiegel-deadlock)', () => {
    const text = sqlText(frag())
    // Omgekeerde richting: een dedicated deploy-peer met hogere tier mag
    // NULL-capability-jobs niet "reserveren" die hij zelf nooit claimt.
    expect(text).toMatch(/WHEN w\.capabilities = ARRAY\['deploy'\]::text\[\]/i)
    expect(text).toMatch(
      /THEN cj\.kind = 'DEPLOY'\s+AND cj\.required_capability = 'deploy'\s+AND cj\.source IN \('SYSTEM', 'MANUAL'\)/i
    )
  })

  it('de guard staat bínnen het NOT EXISTS-blok (vóór de idle-check), niet erbuiten', () => {
    const text = sqlText(frag())
    const notExistsStart = text.search(/AND NOT EXISTS/i)
    const guardPos = text.search(/cj\.required_capability = ANY\(w\.capabilities\)/i)
    const idleCheckPos = text.search(/k\.worker_instance_id/i)
    expect(notExistsStart).toBeGreaterThan(-1)
    expect(guardPos).toBeGreaterThan(notExistsStart)
    expect(guardPos).toBeLessThan(idleCheckPos)
  })

  it('introduceert géén nieuwe bound values (alles literals; volgorde ongewijzigd)', () => {
    expect(frag().values).toEqual(['u1', 'CLAUDE', 'i1', 'LOW_P'])
  })

  it('de guard hangt met AND (niet OR / AND NOT) aan de peer-selectie', () => {
    const text = sqlText(frag())
    // Mutatie-overlevers uit de adversariële review: OR CASE zou de NOT EXISTS
    // vrijwel altijd waar maken (claim-freeze), AND NOT CASE inverteert de
    // guard. Beide vormen mogen niet voorkomen; de AND-vorm moet exact zo.
    expect(text).toMatch(/AND CASE\s+WHEN w\.capabilities/i)
    expect(text).not.toMatch(/OR CASE\s+WHEN w\.capabilities/i)
    expect(text).not.toMatch(/AND NOT CASE\s+WHEN w\.capabilities/i)
  })

  it('tier-vergelijking blijft strikt groter-dan (>= zou same-tier wederzijds laten deadlocken)', () => {
    const text = sqlText(frag())
    expect(text).toMatch(/END\s*>\s*CASE/i)
    expect(text).not.toMatch(/END\s*>=\s*CASE/i)
  })
})

describe('priority mapping (regression for 2026-06-08 enum-ordinal bug)', () => {
  it('encodes HIGH_P=3, MEDIUM_P=2, LOW_P=1 in the SQL (not enum ordinal)', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'LOW_P',
    })
    const text = sqlText(frag)
    // Both CASE expressions must contain the explicit HIGH=3, MEDIUM=2, LOW=1 mapping.
    const caseClauses = text.match(/CASE[^E]*WHEN 'HIGH_P' THEN 3 WHEN 'MEDIUM_P' THEN 2 WHEN 'LOW_P' THEN 1[^E]*END/g)
    expect(caseClauses).not.toBeNull()
    expect(caseClauses!.length).toBe(2)
  })

  it('does NOT use the bare enum-ordinal comparison w.capability > ?::"WorkerCapability"', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'LOW_P',
    })
    const text = sqlText(frag)
    // The bug was an enum-ordinal comparison; the fix replaces it with CASE-priority.
    // Either of these would signal a regression to the pre-fix shape.
    expect(text).not.toMatch(/w\.capability\s*>\s*\?::"WorkerCapability"/i)
    expect(text).not.toMatch(/w\.capability\s*<\s*\?::"WorkerCapability"/i)
  })

  it('still passes the selfCapability through as a bound value (for the CASE rhs)', () => {
    const frag = buildHigherTierIdleFragment({
      selfUserId: 'u1',
      selfInstanceId: 'i1',
      selfRuntime: 'CLAUDE',
      selfCapability: 'MEDIUM_P',
    })
    // The bound values list stays unchanged in shape: userId, runtime, instanceId, capability
    expect(frag.values).toEqual(['u1', 'CLAUDE', 'i1', 'MEDIUM_P'])
  })
})
