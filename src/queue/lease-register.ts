// In-memory lease register (spec §5.4): claims are bound to THIS process
// incarnation. The map holds message_id → {claimToken, claimedBy}; queue_done/
// queue_fail require a matching local entry before touching the DB, so a
// successor process can never finish a predecessor's claim — even within the
// lease window. Phase 3 adds the 10 s refresh tick + pruning on top of this
// exact interface; do not rename these exports.

export interface QueueLease {
  claimToken: string
  claimedBy: string
}

const leases = new Map<string, QueueLease>()

export function registerLease(messageId: string, lease: QueueLease): void {
  leases.set(messageId, lease)
}

export function getLease(messageId: string): QueueLease | undefined {
  return leases.get(messageId)
}

export function releaseLease(messageId: string): void {
  leases.delete(messageId)
}

export function leaseEntries(): Array<{ messageId: string; claimToken: string; claimedBy: string }> {
  return [...leases.entries()].map(([messageId, lease]) => ({
    messageId,
    claimToken: lease.claimToken,
    claimedBy: lease.claimedBy,
  }))
}

/** Test helper: simulates a fresh process incarnation (empty register). */
export function clearLeases(): void {
  leases.clear()
}
