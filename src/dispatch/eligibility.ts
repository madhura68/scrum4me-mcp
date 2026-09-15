import { Prisma } from '@prisma/client'
import type { DispatchInput, DispatchProfileConfig } from '@shared/queue-dispatch.js'
type WorkerRuntime = 'CLAUDE' | 'CODEX'

export type ClaimFilterInput = {
  runtime: WorkerRuntime
  hasProductScope: boolean
  capabilities?: string[]
}

export type ClaimSqlFilterInput =
  | (ClaimFilterInput & { userId: string; hasProductScope: false; productId?: undefined })
  | (ClaimFilterInput & { userId: string; hasProductScope: true; productId: string })

const CLAIMABLE_STANDALONE_KINDS = "('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'IDEA_MAKE_SPEC', 'IDEA_REVISE_SPEC', 'IDEA_CHAT', 'PLAN_CHAT', 'PR_REVIEW', 'SPEC_REVIEW', 'TASK_REVIEW')"

const CLAIMABLE_JOB_KIND_FILTER = `AND (
              (cj.kind IN ${CLAIMABLE_STANDALONE_KINDS} AND cj.source <> 'ORCHESTRATOR')
              OR (cj.kind = 'DEPLOY' AND cj.source IN ('SYSTEM', 'MANUAL'))
              OR (cj.kind = 'DOCS_AUDIT' AND cj.source IN ('SYSTEM', 'MANUAL'))
              OR (cj.kind = 'PLAN_CHAT'
                  AND cj.source = 'ORCHESTRATOR'
                  AND cj.task_id IS NULL
                  AND cj.idea_id IS NULL
                  AND cj.sprint_run_id IS NULL)
              OR (cj.kind = 'TASK_IMPLEMENTATION' AND cj.source IN ('MANUAL', 'COPILOT'))
              OR (cj.kind IN ('TASK_IMPLEMENTATION', 'SPRINT_IMPLEMENTATION')
                  AND cj.sprint_run_id IS NOT NULL
                  AND sr.status IN ('QUEUED', 'RUNNING'))
            )`

export function buildClaimableJobWhereClause(input: ClaimFilterInput): string {
  const productScope = input.hasProductScope ? 'AND cj.product_id = ${productId}' : ''

  // M17 (opus plan-review): een worker met exact ['deploy'] is een dedicated
  // deploy-worker — hard beperken tot DEPLOY. Sluit de NULL-capability-tak
  // uit zodat hij nooit idea/plan-chat-jobs (capability NULL) kan claimen.
  // Workers met éxtra capabilities naast 'deploy' (bv. ['deploy','review'])
  // vallen bewust terug op het generieke pad — volledige deploy-only-isolatie
  // geldt alleen voor exact ['deploy'] (dedicated worker).
  const deployOnly =
    (input.capabilities ?? []).length === 1 && input.capabilities?.[0] === 'deploy'
  if (deployOnly) {
    return `
          WHERE cj.user_id = \${userId}
            ${productScope}
            AND cj.runtime = '${input.runtime}'
            AND cj.status = 'QUEUED'
            AND cj.dispatch_request_id IS NULL
            AND cj.required_capability = 'deploy'
            AND cj.kind = 'DEPLOY'
            AND cj.source IN ('SYSTEM', 'MANUAL')
  `
  }

  // M19 (codex-review): een worker met exact ['docs_audit'] is een dedicated
  // docs-worker — hard beperken tot DOCS_AUDIT en de NULL-capability-tak
  // uitsluiten, zodat hij (met FORGEJO_TOKEN + Edit/Write/Bash) nooit een
  // idea/plan-chat-job kan claimen. Byte-symmetrisch met deployOnly.
  const docsAuditOnly =
    (input.capabilities ?? []).length === 1 && input.capabilities?.[0] === 'docs_audit'
  if (docsAuditOnly) {
    return `
          WHERE cj.user_id = \${userId}
            ${productScope}
            AND cj.runtime = '${input.runtime}'
            AND cj.status = 'QUEUED'
            AND cj.dispatch_request_id IS NULL
            AND cj.required_capability = 'docs_audit'
            AND cj.kind = 'DOCS_AUDIT'
            AND cj.source IN ('SYSTEM', 'MANUAL')
  `
  }

  const capabilityFilter = input.capabilities && input.capabilities.length > 0
    ? 'AND (cj.required_capability IS NULL OR cj.required_capability = ANY(${capabilities}::text[]))'
    : 'AND cj.required_capability IS NULL'
  return `
          WHERE cj.user_id = \${userId}
            ${productScope}
            AND cj.runtime = '${input.runtime}'
            AND cj.status = 'QUEUED'
            AND cj.dispatch_request_id IS NULL
            ${capabilityFilter}
            ${CLAIMABLE_JOB_KIND_FILTER}
  `
}

export function buildClaimableJobWhereFragment(input: ClaimSqlFilterInput): Prisma.Sql {
  const e: ClaimExecutor = {
    userId: input.userId, productIds: input.hasProductScope ? [input.productId] : [], runtime: input.runtime,
    capabilities: input.capabilities ?? [], managed: false, profileRevisionIds: [], quotaPct: null, minQuotaPct: 0
  }
  return Prisma.sql`WHERE ${claimConditions.user.sql(e)}
    ${input.hasProductScope ? Prisma.sql`AND cj.product_id = ${input.productId}` : Prisma.empty}
    AND ${claimConditions.runtime.sql(e)} AND ${claimConditions.queued.sql(e)}
    AND ${claimConditions.binding.sql(e)} AND ${claimConditions.capability.sql(e)}
    ${e.capabilities.length === 1 && ['deploy', 'docs_audit'].includes(e.capabilities[0]) ? Prisma.empty : Prisma.sql`AND ${claimConditions.kind.sql(e)}`}`
}

export type HigherTierIdleInput = {
  selfUserId: string
  selfInstanceId: string
  selfRuntime: WorkerRuntime
  selfCapability: 'HIGH_P' | 'MEDIUM_P' | 'LOW_P' | null
}

/**
 * Returns a SQL fragment that the caller appends inside the WHERE-clause of a
 * claim query. Excludes claims when another alive idle worker with strictly
 * higher capability exists for the same user + runtime — but only if that
 * worker could itself claim the candidate job (see claimability-guard below).
 *
 * Peer product scope is persisted at worker registration and narrowed here.
 * Managed peers use the frozen incarnation scope in eligibleExecutors.
 *
 * Priority mapping (NOT the enum ordinal — see below):
 *   HIGH_P   = 3
 *   MEDIUM_P = 2
 *   LOW_P    = 1
 *
 * Why explicit CASE instead of `w.capability > selfCapability`:
 * The WorkerCapability enum is declared HIGH_P, MEDIUM_P, LOW_P (descending
 * priority), which gives Postgres-ordinals HIGH_P=1, MEDIUM_P=2, LOW_P=3 —
 * exactly inverted vs. semantic priority. A direct `>` comparison therefore
 * finds LOWER-tier workers, not higher ones (the 2026-06-08 canary bug; see
 * docs/superpowers/plans/2026-06-08-tier-preference-enum-ordinal-fix.md).
 *
 * Null-capability semantics: if either self or peer has NULL capability, the
 * CASE evaluates to NULL (no WHEN matched) and the comparison drops the row —
 * preserving the pre-fix "legacy worker without capability blocks no-one"
 * behaviour. Note: the call-site in tryClaimJob also bypasses this fragment
 * entirely when selfCapability === null (see wait-for-job.ts ~L586), so
 * active legacy NULL workers can still first-come claim until rollout
 * populates capability everywhere.
 *
 * Claimability-guard (M17 E2E-vondst 2026-07-04, tier-deadlock): een
 * hogere-tier idle peer telt alleen als die de kandidaat-job (cj, uit de
 * omvattende claim-query) zélf zou kunnen claimen. Zonder deze guard defereert
 * een dedicated deploy-worker met tier LOW_P eeuwig naar idle HIGH_P-workers
 * zonder 'deploy'-capability — de DEPLOY-job blijft dan QUEUED terwijl
 * iedereen "netjes wacht". De twee takken spiegelen de twee claim-paden in
 * buildClaimableJobWhereFragment: exact-['deploy'] peers claimen uitsluitend
 * DEPLOY (deployOnly-pad), overige peers claimen NULL-capability-jobs of jobs
 * waarvan required_capability in hun capabilities zit (generiek pad; lege
 * capabilities ⇒ ANY(leeg)=false ⇒ alleen NULL-jobs).
 */
export function buildHigherTierIdleFragment(input: HigherTierIdleInput): Prisma.Sql {
  return Prisma.sql`
    AND NOT EXISTS (
      SELECT 1 FROM claude_workers w
      LEFT JOIN users u ON u.id = w.user_id
      WHERE w.user_id = ${input.selfUserId}
        AND (w.product_id IS NULL OR w.product_id = cj.product_id)
        AND w.runtime = ${input.selfRuntime}::"AgentRuntime"
        AND w.instance_id <> ${input.selfInstanceId}
        AND CASE w.capability
              WHEN 'HIGH_P' THEN 3
              WHEN 'MEDIUM_P' THEN 2
              WHEN 'LOW_P' THEN 1
            END
          > CASE ${input.selfCapability}::"WorkerCapability"
              WHEN 'HIGH_P' THEN 3
              WHEN 'MEDIUM_P' THEN 2
              WHEN 'LOW_P' THEN 1
            END
        AND CASE
              WHEN w.capabilities = ARRAY['deploy']::text[]
                THEN cj.kind = 'DEPLOY'
                 AND cj.required_capability = 'deploy'
                 AND cj.source IN ('SYSTEM', 'MANUAL')
              WHEN w.capabilities = ARRAY['docs_audit']::text[]
                THEN cj.kind = 'DOCS_AUDIT'
                 AND cj.required_capability = 'docs_audit'
                 AND cj.source IN ('SYSTEM', 'MANUAL')
              ELSE cj.required_capability IS NULL
                OR cj.required_capability = ANY(w.capabilities)
            END
        AND w.last_seen_at > NOW() - INTERVAL '30 seconds'
        AND (w.last_quota_pct IS NULL OR w.last_quota_pct >= COALESCE(u.min_quota_pct, 0))
        AND NOT EXISTS (
          SELECT 1 FROM claude_jobs k
          WHERE k.worker_instance_id = w.instance_id
            AND k.status IN ('CLAIMED','RUNNING')
        )
    )
  `
}


export type ClaimJob = {
  userId: string; productId: string; runtime: string; status: string; kind: string; source: string
  requiredCapability: string | null; dispatchRequestId: string | null; profileRevisionId: string | null
  sprintRunId: string | null; sprintStatus: string | null; earlierSibling: boolean
  taskId: string | null; ideaId: string | null
}
export type ClaimExecutor = {
  userId: string; productIds: string[]; runtime: string; capabilities: string[]
  managed: boolean; incarnationId?: string; profileRevisionIds: string[]; quotaPct: number | null; minQuotaPct: number
}
const standaloneKinds = CLAIMABLE_STANDALONE_KINDS.match(/[A-Z_]+/g)!
/** Named conditions are also exposed independently to SQL consumers. No caller
 * can use a profile id as a substitute for the authenticated managed binding. */
export const claimPredicates = {
  user: (j: ClaimJob, e: ClaimExecutor) => j.userId === e.userId,
  product: (j: ClaimJob, e: ClaimExecutor) => e.productIds.includes(j.productId),
  runtime: (j: ClaimJob, e: ClaimExecutor) => j.runtime === e.runtime,
  queued: (j: ClaimJob) => j.status === 'QUEUED',
  binding: (j: ClaimJob, e: ClaimExecutor) => e.managed
    ? !!e.incarnationId && j.dispatchRequestId !== null && j.profileRevisionId !== null && e.profileRevisionIds.includes(j.profileRevisionId)
    : j.dispatchRequestId === null,
  capability: (j: ClaimJob, e: ClaimExecutor) => {
    if (e.capabilities.length === 1 && ['deploy', 'docs_audit'].includes(e.capabilities[0])) {
      return j.requiredCapability === e.capabilities[0] && j.kind === e.capabilities[0].toUpperCase() && ['SYSTEM', 'MANUAL'].includes(j.source)
    }
    return j.requiredCapability === null || e.capabilities.includes(j.requiredCapability)
  },
  kind: (j: ClaimJob, e: ClaimExecutor) => e.managed
    ? j.source === 'COPILOT' && ['QUEUE_TASK', 'QUEUE_REVIEW', 'TASK_IMPLEMENTATION'].includes(j.kind) && j.sprintRunId === null
    : (standaloneKinds.includes(j.kind) && j.source !== 'ORCHESTRATOR')
    || (['DEPLOY', 'DOCS_AUDIT'].includes(j.kind) && ['SYSTEM', 'MANUAL'].includes(j.source))
    || (j.kind === 'PLAN_CHAT' && j.source === 'ORCHESTRATOR' && !j.taskId && !j.ideaId && !j.sprintRunId)
    || (j.kind === 'TASK_IMPLEMENTATION' && ['MANUAL', 'COPILOT'].includes(j.source))
    || (['TASK_IMPLEMENTATION', 'SPRINT_IMPLEMENTATION'].includes(j.kind) && j.sprintRunId !== null && ['QUEUED', 'RUNNING'].includes(j.sprintStatus ?? '')),
  sprint: (j: ClaimJob) => j.kind !== 'TASK_IMPLEMENTATION' || !j.sprintRunId || !j.earlierSibling,
  quota: (_j: ClaimJob, e: ClaimExecutor) => e.quotaPct === null || e.quotaPct >= e.minQuotaPct,
}
export function evaluateClaimPredicates(job: ClaimJob, executor: ClaimExecutor): string[] {
  return Object.entries(claimPredicates).filter(([, predicate]) => !predicate(job, executor)).map(([name]) => name)
}

/** Both evaluations and SQL builders enumerate this named contract. SQL is
 * parameterized; the only raw fragment is the existing fixed kind policy. */
const claimConditionSql: Record<keyof typeof claimPredicates, (e: ClaimExecutor) => Prisma.Sql> = {
  user: e => Prisma.sql`cj.user_id = ${e.userId}`,
  product: e => Prisma.sql`cj.product_id = ANY(${e.productIds}::text[])`,
  runtime: e => Prisma.sql`cj.runtime = ${e.runtime}::"AgentRuntime"`,
  queued: () => Prisma.sql`cj.status = 'QUEUED'`,
  binding: e => e.managed ? Prisma.sql`cj.dispatch_request_id IS NOT NULL AND dc.profile_revision_id::text = ANY(${e.profileRevisionIds}::text[])
  AND EXISTS(SELECT 1 FROM queue_dispatch_incarnations di JOIN queue_dispatch_profiles dp ON dp.id=dc.profile_revision_id
   WHERE di.id=${e.incarnationId ?? null}::uuid AND di.signed_off_at IS NULL AND dp.revoked_at IS NULL
    AND di.runtime_scope->'profile_revision_ids' ? dc.profile_revision_id::text)`: Prisma.sql`cj.dispatch_request_id IS NULL`,
  capability: e => {
    if (e.capabilities.length === 1 && e.capabilities[0] === 'deploy') return Prisma.sql`cj.required_capability = 'deploy' AND cj.kind = 'DEPLOY' AND cj.source IN ('SYSTEM', 'MANUAL')`
    if (e.capabilities.length === 1 && e.capabilities[0] === 'docs_audit') return Prisma.sql`cj.required_capability = 'docs_audit' AND cj.kind = 'DOCS_AUDIT' AND cj.source IN ('SYSTEM', 'MANUAL')`
    return e.capabilities.length ? Prisma.sql`(cj.required_capability IS NULL OR cj.required_capability = ANY(${e.capabilities}::text[]))` : Prisma.sql`cj.required_capability IS NULL`
  },
  kind: e => e.managed ? Prisma.sql`cj.source = 'COPILOT' AND cj.kind IN ('QUEUE_TASK','QUEUE_REVIEW','TASK_IMPLEMENTATION') AND cj.sprint_run_id IS NULL` : Prisma.raw(CLAIMABLE_JOB_KIND_FILTER.replace(/^AND /, '')),
  sprint: () => Prisma.sql`(cj.kind <> 'TASK_IMPLEMENTATION' OR cj.sprint_run_id IS NULL OR NOT EXISTS
  (SELECT 1 FROM claude_jobs earlier WHERE earlier.sprint_run_id=cj.sprint_run_id AND earlier.kind='TASK_IMPLEMENTATION'
   AND earlier.sprint_sequence<cj.sprint_sequence AND earlier.status IN ('QUEUED','CLAIMED','RUNNING')))`,
  quota: e => Prisma.sql`(${e.quotaPct}::int IS NULL OR ${e.quotaPct}::int >= ${e.minQuotaPct}::int)`,
}
export const claimConditions = Object.fromEntries(Object.entries(claimPredicates).map(([name, evaluate]) =>
  [name, { evaluate, sql: claimConditionSql[name as keyof typeof claimPredicates] }])) as Record<keyof typeof claimPredicates, { evaluate: (j: ClaimJob, e: ClaimExecutor) => boolean; sql: (e: ClaimExecutor) => Prisma.Sql }>
/** Managed callers join queue_dispatch_candidates AS dc and supply an already
 * authenticated, current and frozen incarnation binding; this is not auth. */
export function buildClaimPredicateFragment(executor: ClaimExecutor): Prisma.Sql {
  return Prisma.join(Object.values(claimConditions).map(condition => Prisma.sql`(${condition.sql(executor)})`), ' AND ')
}

export type ManagedSlotConfig = {
  version: 1; runtime: WorkerRuntime; product_ids: string[]; capabilities: string[]
  tier: 'HIGH_P' | 'MEDIUM_P' | 'LOW_P' | null; worker_instance_id: string | null
}
export type RegisteredProfile = { id: string; owner_user_id: string; config: DispatchProfileConfig; revoked_at: Date | null; sha256: string }
export type RegisteredSlot = {
  id: string; kind: 'job' | 'host'; owner_user_id: string; token_id: string; enabled: boolean
  config: ManagedSlotConfig; profile_revision_ids: string[]; incarnation_id: string | null
  incarnation_profile_ids: string[]; last_seen_at: Date | null; signed_off_at: Date | null; busy: boolean
  worker_seen_at: Date | null; live_job: boolean; open_reservation: boolean; ordinary_request_claim: boolean
  quota_pct: number | null; min_quota_pct: number; last_reserved_at: Date | null
  current_product_ids: string[]; current_capabilities: string[]; current_runtime: string | null
}
export type EligiblePool = {
  route: 'job' | 'host'; profileRevisionId: string; slotIds: string[]; loadRatio: number; lastReservedAt: number
}
export const tierPriority = (tier: ManagedSlotConfig['tier']) => tier === 'HIGH_P' ? 3 : tier === 'MEDIUM_P' ? 2 : tier === 'LOW_P' ? 1 : 0
export function requestJob(input: DispatchInput, userId: string, runtime: string, profileRevisionId: string, requestId = 'new'): ClaimJob {
  return {
    userId, productId: input.product_id, runtime, status: 'QUEUED',
    kind: input.action === 'review' ? 'QUEUE_REVIEW' : input.action === 'task_implementation' ? 'TASK_IMPLEMENTATION' : 'QUEUE_TASK',
    source: 'COPILOT', requiredCapability: input.action === 'review' ? 'review' : input.requirements.access === 'repo_write' ? 'code_edit' : null,
    dispatchRequestId: requestId, profileRevisionId, sprintRunId: null, sprintStatus: null, earlierSibling: false, taskId: input.task_id ?? null, ideaId: null
  }
}
export function eligibleExecutors(request: { id: string; user_id: string; input: DispatchInput }, profiles: RegisteredProfile[], slots: RegisteredSlot[], now: Date): EligiblePool[] {
  const pools: EligiblePool[] = []
  for (const profile of profiles) {
    const p = profile.config; const input = request.input
    if (profile.revoked_at || profile.owner_user_id !== request.user_id || p.protocol !== 'dispatch-v1'
      || !p.product_ids.includes(input.product_id) || !p.actions.includes(input.action)
      || (input.requirements.runtime && input.requirements.runtime !== p.runtime)
      || (input.requirements.access === 'repo_write' && p.access !== 'repo_write')
      || !p.publish_modes.includes(input.publish)
      || input.requirements.environment_keys.some(k => !p.environment_keys.includes(k))
      || (input.requirements.repository && !p.repository_product_ids.includes(input.requirements.repository.product_id))
      || input.review_documents?.items.some(r => !p.product_ids.includes(r.product_id)
        || (r.source === 'git' && !p.repository_product_ids.includes(r.product_id)))) continue
    const job = requestJob(input, request.user_id, p.runtime, profile.id, request.id)
    for (const route of ['job', 'host'] as const) {
      // DISTINCT slot identity prevents many profile bindings inflating capacity.
      const suitable = [...new Map(slots.filter(s => s.kind === route && s.enabled && s.incarnation_id && !s.signed_off_at
        && s.profile_revision_ids.includes(profile.id) && s.incarnation_profile_ids.includes(profile.id)
        && s.last_seen_at && now.getTime() - s.last_seen_at.getTime() < (route === 'job' ? 30_000 : 45_000)
        && (route !== 'job' || (s.worker_seen_at && now.getTime() - s.worker_seen_at.getTime() < 30_000))
        && s.current_runtime === s.config.runtime
        && evaluateClaimPredicates(job, {
          userId: s.owner_user_id, runtime: s.config.runtime,
          productIds: s.config.product_ids.filter(id => s.current_product_ids.includes(id)),
          capabilities: s.config.capabilities,
          incarnationId: s.incarnation_id!, profileRevisionIds: s.incarnation_profile_ids, managed: true, quotaPct: s.quota_pct, minQuotaPct: s.min_quota_pct
        }).length === 0
        && evaluateClaimPredicates(job, { userId: s.owner_user_id, runtime: s.current_runtime ?? '', productIds: s.current_product_ids, capabilities: s.current_capabilities, incarnationId: s.incarnation_id!, profileRevisionIds: s.incarnation_profile_ids, managed: true, quotaPct: s.quota_pct, minQuotaPct: s.min_quota_pct }).length === 0)
        .map(s => [s.id, s])).values()]
      const free = suitable.filter(s => !s.busy && !s.open_reservation && !s.live_job && !s.ordinary_request_claim)
      if (!free.length) continue
      // A higher tier only ranks workers in this actually claimable pool.
      free.sort((a, b) => tierPriority(b.config.tier) - tierPriority(a.config.tier) || a.id.localeCompare(b.id))
      pools.push({
        route, profileRevisionId: profile.id, slotIds: free.map(s => s.id),
        loadRatio: (suitable.length - free.length) / suitable.length,
        lastReservedAt: Math.max(0, ...suitable.map(s => s.last_reserved_at?.getTime() ?? 0))
      })
    }
  }
  return pools.sort((a, b) => Number(a.route === 'host') - Number(b.route === 'host') || a.loadRatio - b.loadRatio
    || a.lastReservedAt - b.lastReservedAt || a.profileRevisionId.localeCompare(b.profileRevisionId) || a.slotIds[0].localeCompare(b.slotIds[0]))
}
