// Port van Scrum4Me lib/job-config-snapshot.ts: requested_*-velden op
// enqueue-tijd. Bij claim herresolvet wait-for-job dezelfde config; gezette
// requested_* winnen dan boven product/kind-defaults.
import { prisma } from '../../prisma.js'
import { resolveJobConfig, snapshotFromConfig, type ClaudeJobSnapshotFields } from '../job-config.js'

export async function getJobConfigSnapshot(opts: {
  kind: string
  productId: string
  taskId?: string | null
}): Promise<ClaudeJobSnapshotFields> {
  const [product, task] = await Promise.all([
    prisma.product.findUnique({
      where: { id: opts.productId },
      select: {
        preferred_model: true,
        thinking_budget_default: true,
        preferred_permission_mode: true,
      },
    }),
    opts.taskId
      ? prisma.task.findUnique({
          where: { id: opts.taskId },
          select: { requires_opus: true },
        })
      : Promise.resolve(null),
  ])
  const cfg = resolveJobConfig({ kind: opts.kind }, product ?? {}, task ?? undefined)
  return snapshotFromConfig(cfg)
}
