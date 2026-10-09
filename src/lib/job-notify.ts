// IDEA-243: één bron voor de `scrum4me_changes`-jobnotify. De dispatch-route
// (raw pg PoolClient) en de gewone/HTTP-route (Prisma) sturen exact dezelfde
// payload, zodat workers per event de actuele rij kan ophalen.
//
// Foutbeleid: binnen een transactie mag de notify gooien (de tx breekt dan af);
// buiten een tx (`bestEffort`) wordt gelogd en nooit gerethrowd. Een
// best-effort-aanroeper plaatst de notify ná zijn eigen side-effects.
import type { PoolClient } from 'pg'
import type { Prisma, PrismaClient } from '@prisma/client'

export const JOB_NOTIFY_CHANNEL = 'scrum4me_changes'
// pg_notify faalt vanaf 8000 bytes; binnen een tx breekt dat de tx af.
export const JOB_NOTIFY_MAX_BYTES = 7500

export type JobNotifyRow = {
  id: string
  user_id: string
  product_id: string
  kind: string
  status: string
  runtime?: string | null
  source?: string | null
  branch?: string | null
  pushed_at?: Date | string | null
  pr_url?: string | null
  verify_result?: string | null
  summary?: string | null
  error?: string | null
  task_id?: string | null
  idea_id?: string | null
}

const bytes = (p: unknown): number => Buffer.byteLength(JSON.stringify(p), 'utf8')

// Halveer op code-point-grenzen (geen gesplitste surrogate-paren); leeg → weglaten.
function halve(value: string): string | undefined {
  const cps = Array.from(value)
  const half = cps.slice(0, Math.floor(cps.length / 2)).join('')
  return half.length > 0 ? half : undefined
}

function shrink(p: Record<string, unknown>, field: 'summary' | 'error'): void {
  while (typeof p[field] === 'string' && bytes(p) > JOB_NOTIFY_MAX_BYTES) {
    const next = halve(p[field] as string)
    if (next === undefined) delete p[field]
    else p[field] = next
  }
}

export function jobChangedPayload(row: JobNotifyRow): Record<string, unknown> {
  const pushedAt =
    row.pushed_at == null
      ? undefined
      : row.pushed_at instanceof Date
        ? row.pushed_at.toISOString()
        : String(row.pushed_at)
  const p: Record<string, unknown> = {
    type: 'claude_job_status_changed',
    job_id: row.id,
    user_id: row.user_id,
    product_id: row.product_id,
    kind: row.kind,
    status: row.status,
    runtime: row.runtime ?? 'CLAUDE',
    source: row.source ?? 'SYSTEM',
  }
  const optional: Record<string, unknown> = {
    branch: row.branch ?? undefined,
    pushed_at: pushedAt,
    pr_url: row.pr_url ?? undefined,
    verify_result: row.verify_result?.toLowerCase() ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    task_id: row.task_id ?? undefined,
    idea_id: row.idea_id ?? undefined,
  }
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) p[k] = v

  if (bytes(p) > JOB_NOTIFY_MAX_BYTES) {
    shrink(p, 'summary')
    shrink(p, 'error')
    // Alleen als het nog nodig is: branch en pr_url.
    if (bytes(p) > JOB_NOTIFY_MAX_BYTES) delete p.branch
    if (bytes(p) > JOB_NOTIFY_MAX_BYTES) delete p.pr_url
  }
  return p
}

const SELECT_COLUMNS =
  'id, user_id, product_id, kind, status, runtime, source, branch, pushed_at, pr_url, verify_result, summary, error, task_id, idea_id'

/** Raw pg: leest de rij en stuurt pg_notify op dezelfde client (tx-bewust). Ontbrekende rij = no-op. */
export async function notifyJobChanged(db: PoolClient, jobId: string): Promise<void> {
  const row = (
    await db.query(`SELECT ${SELECT_COLUMNS} FROM claude_jobs WHERE id=$1`, [jobId])
  ).rows[0] as JobNotifyRow | undefined
  if (!row) return
  await db.query('SELECT pg_notify($1, $2)', [JOB_NOTIFY_CHANNEL, JSON.stringify(jobChangedPayload(row))])
}

/** Prisma: idem. Met `bestEffort` wordt een fout gelogd en niet gerethrowd (buiten een tx). */
export async function notifyJobChangedPrisma(
  client: Prisma.TransactionClient | PrismaClient,
  jobId: string,
  opts: { bestEffort?: boolean } = {},
): Promise<void> {
  try {
    const row = await client.claudeJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        user_id: true,
        product_id: true,
        kind: true,
        status: true,
        runtime: true,
        source: true,
        branch: true,
        pushed_at: true,
        pr_url: true,
        verify_result: true,
        summary: true,
        error: true,
        task_id: true,
        idea_id: true,
      },
    })
    if (!row) return
    const payload = JSON.stringify(jobChangedPayload(row as JobNotifyRow))
    await client.$executeRaw`SELECT pg_notify(${JOB_NOTIFY_CHANNEL}, ${payload})`
  } catch (err) {
    if (!opts.bestEffort) throw err
    console.warn(`notifyJobChangedPrisma failed for job ${jobId}:`, err)
  }
}
