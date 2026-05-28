import { Client } from 'pg'
import { prisma } from '../prisma.js'

export async function registerWorker(opts: {
  userId: string
  tokenId: string
  productId?: string | null
  runtime?: 'CLAUDE' | 'CODEX'
  capabilities?: string[]
  instanceId: string
  hostname?: string | null
  pid?: number | null
}): Promise<void> {
  await prisma.claudeWorker.upsert({
    where: {
      user_id_token_id_instance_id: {
        user_id: opts.userId,
        token_id: opts.tokenId,
        instance_id: opts.instanceId,
      },
    },
    create: {
      user_id: opts.userId,
      token_id: opts.tokenId,
      runtime: opts.runtime ?? 'CLAUDE',
      capabilities: opts.capabilities ?? [],
      instance_id: opts.instanceId,
      product_id: opts.productId ?? null,
      hostname: opts.hostname ?? null,
      pid: opts.pid ?? null,
    },
    update: {
      // Heal stale rows after a token user-migration: if an admin re-points
      // ApiToken.user_id, the next heartbeat/re-register writes the current
      // user_id instead of leaving the row stuck on the old owner.
      user_id: opts.userId,
      last_seen_at: new Date(),
      product_id: opts.productId ?? null,
      runtime: opts.runtime ?? 'CLAUDE',
      capabilities: opts.capabilities ?? [],
      instance_id: opts.instanceId,
      hostname: opts.hostname ?? null,
      pid: opts.pid ?? null,
    },
  })

  try {
    const pg = new Client({ connectionString: process.env.DATABASE_URL })
    await pg.connect()
    await pg.query('SELECT pg_notify($1, $2)', [
      'scrum4me_changes',
      JSON.stringify({
        type: 'claude_worker_heartbeat',
        worker_id: opts.tokenId,
        user_id: opts.userId,
        token_id: opts.tokenId,
        instance_id: opts.instanceId,
        product_id: opts.productId ?? null,
        runtime: opts.runtime ?? 'CLAUDE',
        capabilities: opts.capabilities ?? [],
      }),
    ])
    await pg.end()
  } catch {
    // non-fatal
  }
}

export async function unregisterWorker(opts: {
  userId: string
  tokenId: string
  instanceId: string
}): Promise<void> {
  const worker = await prisma.claudeWorker
    .findFirst({
      where: {
        user_id: opts.userId,
        token_id: opts.tokenId,
        instance_id: opts.instanceId,
      },
      select: { runtime: true },
    })
    .catch(() => null)

  // Scope delete by composite key so multi-worker setups only retire the
  // exiting instance, not every worker sharing this token.
  await prisma.claudeWorker
    .deleteMany({
      where: {
        user_id: opts.userId,
        token_id: opts.tokenId,
        instance_id: opts.instanceId,
      },
    })
    .catch(() => {})

  try {
    const pg = new Client({ connectionString: process.env.DATABASE_URL })
    await pg.connect()
    await pg.query('SELECT pg_notify($1, $2)', [
      'scrum4me_changes',
      JSON.stringify({
        type: 'claude_worker_offline',
        worker_id: opts.tokenId,
        user_id: opts.userId,
        token_id: opts.tokenId,
        instance_id: opts.instanceId,
        runtime: worker?.runtime ?? 'CLAUDE',
      }),
    ])
    await pg.end()
  } catch {
    // non-fatal
  }
}
