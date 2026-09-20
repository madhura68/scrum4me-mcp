// IDEA-118 spec §6.3 (v0.4): enkelvoudige task-dispatch voor COPILOT.
// Gate: task moet TO_DO zijn én geen actieve job hebben.
import { prisma } from '../../prisma.js'
import { getJobConfigSnapshot } from './snapshot.js'
import { notifyJobEnqueued } from './notify.js'
import { DispatchError } from './errors.js'

// The Task is exclusive, so whoever holds it — an ordinary job or a managed dispatch — the requester
// reads the same sentence. A managed holder shows up two ways: on the Task row this transaction
// locks, or, when the managed side commits while this transaction runs, as the Task guard refusing
// the INSERT from inside PostgreSQL. Never let that bare code reach the user.
const TASK_BUSY = 'Er loopt al een actieve job voor deze task'

/** Prisma 7 driver adapters hand back the driver's own error (a DriverAdapterError whose cause
 * carries SQLSTATE and message); engine fields such as meta.target no longer exist. Match on
 * SQLSTATE 42501 plus the guard's message, walking the cause chain, and on nothing else. */
export function isManagedTaskRefusal(error: unknown): boolean {
  const seen = new Set<object>()
  const walk = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    const e = value as { code?: unknown; message?: unknown; cause?: unknown }
    if (e.code === '42501' && String(e.message ?? '').includes('DISPATCH_MANAGED_ROW')) return true
    return walk(e.cause)
  }
  return walk(error)
}

export async function dispatchTaskImplementation(opts: {
  taskId: string
  productId: string
  userId: string
}, dependencies: { db?: typeof prisma; notify?: typeof notifyJobEnqueued } = {}): Promise<{ job_id: string }> {
  const db = dependencies.db ?? prisma
  const snapshot = await getJobConfigSnapshot({
    kind: 'TASK_IMPLEMENTATION',
    productId: opts.productId,
    taskId: opts.taskId,
  }, db)
  const enqueue = () => db.$transaction(async tx => {
    // Same Task-first lock as managed enqueue; includes duplicate check + create.
    await tx.$queryRaw`SELECT id FROM tasks WHERE id=${opts.taskId} FOR UPDATE`
    const task = await tx.task.findUnique({
      where: { id: opts.taskId },
      select: { id: true, status: true, dispatch_request_id: true, story: { select: { product_id: true } } },
    })
    if (!task || task.story.product_id !== opts.productId) {
      throw new DispatchError(`Task ${opts.taskId} not found in this product`)
    }
    if (task.dispatch_request_id != null) throw new DispatchError(`${TASK_BUSY} (managed dispatch ${task.dispatch_request_id}).`)
    if (task.status !== 'TO_DO') {
      throw new DispatchError(`Task heeft status ${task.status}; alleen TO_DO is dispatchbaar.`)
    }
    const existing = await tx.claudeJob.findFirst({
      where: { task_id: opts.taskId, status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] } },
      select: { id: true },
    })
    if (existing) throw new DispatchError(`${TASK_BUSY} (${existing.id}).`)

    return tx.claudeJob.create({
      data: {
        user_id: opts.userId,
        product_id: opts.productId,
        task_id: opts.taskId,
        kind: 'TASK_IMPLEMENTATION',
        status: 'QUEUED',
        source: 'COPILOT',
        ...snapshot,
      },
      select: { id: true },
    })
  })
  let job: { id: string }
  try { job = await enqueue() }
  catch (error) {
    if (!isManagedTaskRefusal(error)) throw error
    throw new DispatchError(`${TASK_BUSY} (managed dispatch).`)
  }
  await (dependencies.notify ?? notifyJobEnqueued)({
    job_id: job.id, user_id: opts.userId, product_id: opts.productId, kind: 'TASK_IMPLEMENTATION',
  })
  return { job_id: job.id }
}
