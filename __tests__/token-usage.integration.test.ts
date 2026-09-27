import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { recordSuccessfulTokenUse } from '../src/token-usage.js'
import { recordDispatchTokenUse } from '../src/dispatch/token-usage.js'
import { prisma } from '../src/prisma.js'

const dsn = process.env.TOKEN_USAGE_TEST_URL
const db = dsn ? describe : describe.skip

db('bounded monotone usage writers on PostgreSQL', () => {
  let pool: Pool
  const userId = 'usage-' + randomUUID()
  const tokenId = 'usage-' + randomUUID()
  const t1 = new Date('2026-09-27T15:00:00.123Z')
  const t2 = new Date('2026-09-27T16:00:00.456Z')
  beforeAll(async () => {
    const target = new URL(dsn!)
    if (target.hostname !== '127.0.0.1' || target.pathname !== '/s4m_dispatch_test') throw new Error('TEST_TARGET_REFUSED')
    vi.stubEnv('DATABASE_URL', process.env.TOKEN_USAGE_WRITER_URL ?? dsn!)
    pool = new Pool({ connectionString: dsn, max: 4, options: '-c timezone=Pacific/Honolulu' })
    if ((await pool.query("SELECT 1 FROM pg_database WHERE datname='scrum4me'")).rowCount) throw new Error('PRODUCTION_CLUSTER_REFUSED')
    await pool.query('INSERT INTO users(id,username,password_hash,updated_at) VALUES($1,$1,$1,now())', [userId])
    await pool.query('INSERT INTO api_tokens(id,user_id,token_hash) VALUES($1,$2,$1)', [tokenId,userId])
  })
  afterAll(async () => {
    if (pool) { await pool.query('DELETE FROM users WHERE id=$1',[userId]); await pool.end() }
    await prisma.$disconnect()
    vi.unstubAllEnvs()
  })
  const read = async () => (await pool.query("SELECT to_char(last_used_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS') AS value FROM api_tokens WHERE id=$1",[tokenId])).rows[0]?.value
  const reset = async () => pool.query('UPDATE api_tokens SET last_used_at=NULL, revoked_at=NULL WHERE id=$1',[tokenId])
  for (const adapter of ['prisma','dispatch'] as const) {
    const write = (completedAt: Date, owner=userId) => adapter === 'prisma'
      ? recordSuccessfulTokenUse({ tokenId, userId:owner, completedAt })
      : recordDispatchTokenUse(pool,{ tokenId, userId:owner, completedAt })
    it(`${adapter}: null, out of order, concurrent and non-UTC writes`, async () => {
      await reset(); expect(await read()).toBeNull()
      await write(t2); await write(t1)
      expect(await read()).toBe('2026-09-27T16:00:00.456')
      await reset()
      await Promise.all([write(t1),write(t2)])
      expect(await read()).toBe('2026-09-27T16:00:00.456')
    })
    it(`${adapter}: revoked and wrong owner are no-ops`, async () => {
      await reset(); await write(t2,'former-owner'); expect(await read()).toBeNull()
      await pool.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[tokenId])
      await write(t2); expect(await read()).toBeNull()
    })
    it(`${adapter}: contention is bounded and never rejects`, async () => {
      await reset()
      const lock=await pool.connect()
      await lock.query('BEGIN'); await lock.query('SELECT 1 FROM api_tokens WHERE id=$1 FOR UPDATE',[tokenId])
      const started=Date.now()
      try { await expect(write(t2)).resolves.toBeUndefined() }
      finally { await lock.query('ROLLBACK'); lock.release() }
      expect(Date.now()-started).toBeLessThan(2500)
      expect(await read()).toBeNull()
    })
  }
  it('deleted token is a no-op for both adapters', async () => {
    await pool.query('DELETE FROM api_tokens WHERE id=$1',[tokenId])
    await expect(recordSuccessfulTokenUse({tokenId,userId,completedAt:t2})).resolves.toBeUndefined()
    await expect(recordDispatchTokenUse(pool,{tokenId,userId,completedAt:t2})).resolves.toBeUndefined()
    expect(await read()).toBeUndefined()
  })
  it('dispatch releases a client acquired after the deadline', async () => {
    const single=new Pool({connectionString:dsn,max:1})
    const held=await single.connect()
    const start=Date.now()
    await recordDispatchTokenUse(single,{tokenId,userId,completedAt:t2})
    expect(Date.now()-start).toBeLessThan(2000)
    held.release()
    await new Promise(resolve=>setTimeout(resolve,30))
    expect(single.idleCount).toBe(1)
    await single.end()
  })
})
