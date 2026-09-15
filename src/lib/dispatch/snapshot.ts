// Port van Scrum4Me lib/job-config-snapshot.ts: requested_*-velden op
// enqueue-tijd. Bij claim herresolvet wait-for-job dezelfde config.
//
// M39 Fase B (B6): DB-aware. De snapshot leest nu óók de JobKindConfig-rij en
// resolvet via resolveRuntimeJobConfig, zodat een per-kind default die via de
// workers /settings/models- of job-kinds-editor is gezet direct doorwerkt op
// nieuwe enqueues — géén mcp-deploy meer nodig voor een default-switch (heft de
// §1.2-shadowing op: laag 2 stempelt niet langer blind de code-KIND_DEFAULTS).
import { prisma } from '../../prisma.js'
import { resolveRuntimeJobConfig, type ClaudeJobSnapshotFields } from '../job-config.js'

export async function getJobConfigSnapshot(opts: {
  kind: string
  productId: string
  taskId?: string | null
}, db: typeof prisma = prisma): Promise<ClaudeJobSnapshotFields> {
  const [product, task, kindConfig] = await Promise.all([
    db.product.findUnique({
      where: { id: opts.productId },
      select: {
        preferred_model: true,
        thinking_budget_default: true,
        preferred_permission_mode: true,
      },
    }),
    opts.taskId
      ? db.task.findUnique({
          where: { id: opts.taskId },
          select: { requires_opus: true },
        })
      : Promise.resolve(null),
    db.jobKindConfig.findUnique({ where: { kind: opts.kind as never } }),
  ])

  const cfg = resolveRuntimeJobConfig(
    { kind: opts.kind },
    product ?? {},
    task ?? undefined,
    kindConfig ?? undefined,
    'CLAUDE',
  )
  // resolveRuntimeJobConfig retourneert de RuntimeJobConfig-union; alleen de
  // CLAUDE-tak heeft permission_mode (de CODEX-tak heeft sandbox_mode), en het
  // literal 'CLAUDE'-argument versmalt het returntype niet — narrow dus op de
  // discriminant, anders TS2339 op de pretest-typecheck.
  return {
    requested_model: cfg.model,
    requested_thinking_budget: cfg.thinking_budget,
    requested_permission_mode: cfg.runtime === 'CLAUDE' ? cfg.permission_mode : 'default',
  }
}
