// IDEA-118 spec §6.3 (v0.4): enkelvoudige task-dispatch voor COPILOT.
// Gate: task moet TO_DO zijn én geen actieve job hebben.
import { prisma } from '../../prisma.js'
import { getJobConfigSnapshot } from './snapshot.js'
import { notifyJobEnqueued } from './notify.js'
import { DispatchError } from './errors.js'

export async function dispatchTaskImplementation(opts: {
  taskId: string
  productId: string
  userId: string
}): Promise<{ job_id: string }> {
  const task = await prisma.task.findUnique({
    where: { id: opts.taskId },
    select: { id: true, status: true, story: { select: { product_id: true } } },
  })
  if (!task || task.story.product_id !== opts.productId) {
    throw new DispatchError(`Task ${opts.taskId} not found in this product`)
  }
  if (task.status !== 'TO_DO') {
    throw new DispatchError(`Task heeft status ${task.status}; alleen TO_DO is dispatchbaar.`)
  }
  const existing = await prisma.claudeJob.findFirst({
    where: { task_id: opts.taskId, status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] } },
    select: { id: true },
  })
  if (existing) throw new DispatchError(`Er loopt al een actieve job voor deze task (${existing.id}).`)

  const snapshot = await getJobConfigSnapshot({
    kind: 'TASK_IMPLEMENTATION',
    productId: opts.productId,
    taskId: opts.taskId,
  })
  const job = await prisma.claudeJob.create({
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
  await notifyJobEnqueued({
    job_id: job.id, user_id: opts.userId, product_id: opts.productId, kind: 'TASK_IMPLEMENTATION',
  })
  return { job_id: job.id }
}
