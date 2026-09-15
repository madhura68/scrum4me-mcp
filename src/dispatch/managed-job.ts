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
export async function assertUnmanagedJobId(jobId: string): Promise<void> {
    assertUnmanagedJob(await prisma.claudeJob.findUnique({ where: { id: jobId }, select: { task_executions: managedTaskExecutionsSelect, kind: true, dispatch_request_id: true, dispatch_candidate_id: true, task: { select: { dispatch_request_id: true } } } }));
}
export async function assertUnmanagedTask(taskId: string): Promise<void> {
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { dispatch_request_id: true } });
    if (task?.dispatch_request_id != null)
        throw new Error('DISPATCH_MANAGED_ROW');
}
