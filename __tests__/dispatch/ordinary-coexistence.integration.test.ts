import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { makeDispatchHarness, type DispatchHarness, type DispatchHarnessSeed } from './harness.js'
import { buildClaimableJobWhereFragment, buildHigherTierIdleFragment } from '../../src/dispatch/eligibility.js'

let h: DispatchHarness, f: DispatchHarnessSeed
beforeEach(async () => { h = await makeDispatchHarness(); f = await h.seed() })
afterEach(async () => { await h?.close() })

describe('ordinary tier priority with managed-only bootstrap workers', () => {
  it.each([true, false])('managed-only HIGH_P=%s; restricted ordinary SQL preserves actual priority', async managed => {
    const highId = `${managed ? 'managed:' : 'ordinary:'}${randomUUID()}`
    const lowId = `ordinary:${randomUUID()}`, jobId = randomUUID()
    await h.admin.query(`INSERT INTO claude_workers(id,user_id,token_id,instance_id,runtime,capability,last_seen_at)
      VALUES($1,$2,$3,$4,'CODEX','HIGH_P',now()),($5,$2,$3,$6,'CODEX','LOW_P',now())`,
    [randomUUID(), f.actor.userId, f.actor.tokenId, highId, randomUUID(), lowId])
    await h.admin.query(`INSERT INTO claude_jobs(id,user_id,product_id,kind,source,status,runtime,updated_at)
      VALUES($1,$2,$3,'DEPLOY','SYSTEM','QUEUED','CODEX',now())`, [jobId, f.actor.userId, f.input.product_id])
    const client = await h.admin.connect()
    const role = `ip05_ordinary_${randomUUID().replaceAll('-', '')}`
    try {
      // This transaction rolls the test-only role and grants back, even on failure.
      await client.query('BEGIN')
      await client.query(`CREATE ROLE ${role} NOLOGIN`)
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await client.query(`GRANT SELECT ON claude_workers,claude_jobs,users,sprint_runs TO ${role}`)
      await client.query(`SET LOCAL ROLE ${role}`)
      await client.query('SAVEPOINT private_read')
      await expect(client.query('SELECT id FROM queue_dispatch_slots LIMIT 1')).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT private_read')
      const query = (instanceId: string, tier: 'LOW_P' | 'HIGH_P') => Prisma.sql`
        SELECT cj.id FROM claude_jobs cj LEFT JOIN sprint_runs sr ON sr.id=cj.sprint_run_id
        ${buildClaimableJobWhereFragment({ userId: f.actor.userId, productId: f.input.product_id, hasProductScope: true, runtime: 'CODEX' })}
        ${buildHigherTierIdleFragment({ selfUserId: f.actor.userId, selfInstanceId: instanceId, selfRuntime: 'CODEX', selfCapability: tier })}`
      const low = query(lowId, 'LOW_P')
      expect((await client.query(low.text, low.values)).rows).toEqual(managed ? [{ id: jobId }] : [])
      if (!managed) {
        const high = query(highId, 'HIGH_P')
        expect((await client.query(high.text, high.values)).rows).toEqual([{ id: jobId }])
      }
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
