import { prisma } from '../prisma.js';
export type ManagedJobMarkers = {
    kind?: string;
    task_executions?: { task: { dispatch_request_id?: string | null } | null }[];
    task?: { dispatch_request_id?: string | null } | null;
    dispatch_request_id?: string | null;
    dispatch_candidate_id?: string | null;
};
export const managedTaskExecutionsSelect = { where: { task: { dispatch_request_id: { not: null } } }, select: { task: { select: { dispatch_request_id: true } } }, take: 1 } as const;
/** Ordinary consumers read only claude_jobs and tasks; dispatch tables stay private. */
export function assertUnmanagedJob(job: ManagedJobMarkers | null | undefined): void {
    if (job && (job.task_executions?.some(e => e.task?.dispatch_request_id != null) || job.task?.dispatch_request_id != null || job.dispatch_request_id != null || job.dispatch_candidate_id != null || ['QUEUE_TASK', 'QUEUE_REVIEW'].includes(job.kind ?? ''))) {
        throw new Error('DISPATCH_MANAGED_ROW');
    }
}
/** Job-level markers only: whether THIS job row is itself managed. Deliberately blind to the task
 * binding, which records who holds the task NOW — an ordinary job that already ended may have had
 * its task handed to a managed dispatch afterwards, and its own cleanup must still run. */
export type ManagedJobRowMarkers = Pick<ManagedJobMarkers, 'kind' | 'dispatch_request_id' | 'dispatch_candidate_id'>;
export function isManagedJobRow(job: ManagedJobRowMarkers | null | undefined): boolean {
    return job != null && (job.dispatch_request_id != null || job.dispatch_candidate_id != null || ['QUEUE_TASK', 'QUEUE_REVIEW'].includes(job.kind ?? ''));
}
export function assertUnmanagedJobRow(job: ManagedJobRowMarkers | null | undefined): void {
    if (isManagedJobRow(job))
        throw new Error('DISPATCH_MANAGED_ROW');
}
/** Guard for the cleanup path of a job that already ended. Those helpers document that they never
 * throw, so a failing marker read must not break that promise either: it is logged by error name
 * and the cleanup proceeds — the host resources it frees (in-memory locks, this job's own worktree,
 * its own branch) belong to this job alone and are never touched by a managed dispatch. */
export async function assertUnmanagedJobCleanup(jobId: string): Promise<void> {
    let job: ManagedJobMarkers | null;
    try {
        job = await prisma.claudeJob.findUnique({ where: { id: jobId }, select: { kind: true, dispatch_request_id: true, dispatch_candidate_id: true } });
    }
    catch (error) {
        console.warn(`[managed-job] managed-marker read failed for job ${jobId}: ${(error as { name?: string } | null)?.name ?? 'Error'}`);
        return;
    }
    assertUnmanagedJobRow(job);
}
export async function assertUnmanagedJobId(jobId: string): Promise<void> {
    assertUnmanagedJob(await prisma.claudeJob.findUnique({ where: { id: jobId }, select: { task_executions: managedTaskExecutionsSelect, kind: true, dispatch_request_id: true, dispatch_candidate_id: true, task: { select: { dispatch_request_id: true } } } }));
}
/** Prisma 7 driver adapters hand back the driver's own error (a DriverAdapterError whose cause
 * carries SQLSTATE and message); engine fields such as meta.target no longer exist. Match on
 * SQLSTATE 42501 plus the guard's message, walking the cause chain, and on nothing else. This is the
 * single matcher for the managed-row refusal, whether the in-database trigger raised it or the
 * assertUnmanagedTask pre-check below did. */
export function isManagedTaskRefusal(error: unknown): boolean {
    const seen = new Set<object>();
    const walk = (value: unknown): boolean => {
        if (value === null || typeof value !== 'object' || seen.has(value)) return false;
        seen.add(value);
        const e = value as { code?: unknown; message?: unknown; cause?: unknown };
        if (e.code === '42501' && String(e.message ?? '').includes('DISPATCH_MANAGED_ROW')) return true;
        return walk(e.cause);
    };
    return walk(error);
}
/** assertUnmanagedTask catches the managed-row condition before the write reaches the in-database
 * trigger. Mirror the driver-adapter refusal shape (SQLSTATE 42501 on the cause, DISPATCH_MANAGED_ROW
 * in the message) so isManagedTaskRefusal recognizes this pre-check exactly as it recognizes the
 * trigger's own refusal — while a bare Error('DISPATCH_MANAGED_ROW') (the job-level guards' internal
 * sentinel) deliberately stays unmatched. */
function managedTaskRefusal(): Error {
    return Object.assign(new Error('DISPATCH_MANAGED_ROW'), { cause: Object.assign(new Error('DISPATCH_MANAGED_ROW'), { code: '42501' }) });
}
export async function assertUnmanagedTask(taskId: string): Promise<void> {
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { dispatch_request_id: true } });
    if (task?.dispatch_request_id != null)
        throw managedTaskRefusal();
}
