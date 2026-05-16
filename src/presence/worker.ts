import { Client } from 'pg'
import { prisma } from '../prisma.js'

export async function registerWorker(opts: {
  userId: string
  tokenId: string
  productId?: string | null
}): Promise<void> {
  await prisma.claudeWorker.upsert({
    where: { token_id: opts.tokenId },
    create: {
      user_id: opts.userId,
      token_id: opts.tokenId,
      product_id: opts.productId ?? null,
    },
    update: {
      // Heal stale rows after a token user-migration: if an admin re-points
      // ApiToken.user_id, the next heartbeat/re-register writes the current
      // user_id instead of leaving the row stuck on the old owner.
      user_id: opts.userId,
      last_seen_at: new Date(),
      product_id: opts.productId ?? null,
    },
  })

  try {
    const pg = new Client({ connectionString: process.env.DATABASE_URL })
    await pg.connect()
    await pg.query('SELECT pg_notify($1, $2)', [
      'scrum4me_changes',
      JSON.stringify({
        type: 'worker_connected',
        user_id: opts.userId,
        token_id: opts.tokenId,
        product_id: opts.productId ?? null,
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
}): Promise<void> {
  await prisma.claudeWorker.deleteMany({ where: { token_id: opts.tokenId } }).catch(() => {})

  try {
    const pg = new Client({ connectionString: process.env.DATABASE_URL })
    await pg.connect()
    await pg.query('SELECT pg_notify($1, $2)', [
      'scrum4me_changes',
      JSON.stringify({
        type: 'worker_disconnected',
        user_id: opts.userId,
        token_id: opts.tokenId,
      }),
    ])
    await pg.end()
  } catch {
    // non-fatal
  }
}
