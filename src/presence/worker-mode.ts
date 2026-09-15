import { Prisma } from '@prisma/client'

// R11: this reserved namespace persists the poll mode in an ordinary-readable
// column. It grants no dispatch authority. Managed bootstrap must use a stable,
// nonempty suffix; ordinary consumers must never use this namespace.
const MANAGED_WORKER_PREFIX = 'managed:'
export const managedWorkerPollScope = {
  test: (instanceId: string) => instanceId.startsWith(MANAGED_WORKER_PREFIX),
  // The raw SQL literal is built only from the fixed constant above. Keep the
  // existing legacy parameter order and avoid private dispatch-table reads.
  peerSql: Prisma.sql`starts_with(w.instance_id, ${Prisma.raw(`'${MANAGED_WORKER_PREFIX}'`)})`,
}

export function isManagedWorkerInstanceId(instanceId: unknown): instanceId is string {
  return typeof instanceId === 'string'
    && managedWorkerPollScope.test(instanceId)
    && instanceId.length > MANAGED_WORKER_PREFIX.length
    && instanceId.length <= 256
}
