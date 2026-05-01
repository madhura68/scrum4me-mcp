import { Client } from 'pg'
import { prisma } from '../prisma.js'

export async function pgNotify(payload: Record<string, unknown>): Promise<void> {
  const pg = new Client({ connectionString: process.env.DATABASE_URL })
  await pg.connect()
  await pg.query('SELECT pg_notify($1, $2)', ['scrum4me_changes', JSON.stringify(payload)])
  await pg.end()
}

export async function registerWorker(opts: {
  userId: string
  tokenId: string
  productId?: string | null
  notify?: (payload: Record<string, unknown>) => Promise<void>
}): Promise<void> {
  await prisma.claudeWorker.upsert({
    where: { token_id: opts.tokenId },
    create: {
      user_id: opts.userId,
      token_id: opts.tokenId,
      product_id: opts.productId ?? null,
    },
    update: {
      last_seen_at: new Date(),
      product_id: opts.productId ?? null,
    },
  })

  const notify = opts.notify ?? pgNotify
  try {
    await notify({
      type: 'worker_connected',
      user_id: opts.userId,
      token_id: opts.tokenId,
      product_id: opts.productId ?? null,
    })
  } catch {
    // non-fatal
  }
}

export async function unregisterWorker(opts: {
  userId: string
  tokenId: string
  notify?: (payload: Record<string, unknown>) => Promise<void>
}): Promise<void> {
  await prisma.claudeWorker.deleteMany({ where: { token_id: opts.tokenId } }).catch(() => {})

  const notify = opts.notify ?? pgNotify
  try {
    await notify({
      type: 'worker_disconnected',
      user_id: opts.userId,
      token_id: opts.tokenId,
    })
  } catch {
    // non-fatal
  }
}
