import { prisma } from '../prisma.js';
export type ManagedJobMarkers = {
    kind?: string;
    dispatch_request_id?: string | null;
    dispatch_candidate_id?: string | null;
};
/** Ordinary consumers read only claude_jobs; dispatch tables stay private. */
export function assertUnmanagedJob(job: ManagedJobMarkers | null | undefined): void {
    if (job && (job.dispatch_request_id != null || job.dispatch_candidate_id != null || ['QUEUE_TASK', 'QUEUE_REVIEW'].includes(job.kind ?? ''))) {
        throw new Error('DISPATCH_MANAGED_ROW');
    }
}
export async function assertUnmanagedJobId(jobId: string): Promise<void> {
    assertUnmanagedJob(await prisma.claudeJob.findUnique({ where: { id: jobId }, select: { kind: true, dispatch_request_id: true, dispatch_candidate_id: true } }));
}
export async function assertUnmanagedTask(taskId: string): Promise<void> {
    const managed = await prisma.claudeJob.findFirst({ where: { task_id: taskId, dispatch_request_id: { not: null }, status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] } }, select: { id: true } });
    if (managed)
        throw new Error('DISPATCH_MANAGED_ROW');
}
