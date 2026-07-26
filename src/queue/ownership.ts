// Two-stage claimer check (spec §5.4, error precedence pinned in review round 6).
// See the decision matrix in the phase-2 plan. Stage (a)/(b) run against the
// in-memory lease register of THIS process incarnation; stage (c) — strict
// claimed_by equality — is the caller's responsibility inside the same
// FOR UPDATE transaction that read the row.
import { getLease } from './lease-register.js'

export type OwnershipVerdict =
  | { ok: true; expectedClaimedBy: string | null }
  | { ok: false; error: string }

export function verifyLocalOwnership(opts: {
  messageId: string
  rowStatus: string
  claimToken: string | undefined
}): OwnershipVerdict {
  const { messageId, rowStatus, claimToken } = opts

  if (rowStatus === 'pending') {
    if (claimToken !== undefined) {
      // A done/fail WITH token on a pending row signals an expired claim: the
      // zombie finisher must not slip in silently via the FIFO bypass (§5.4).
      return {
        ok: false,
        error:
          `QUEUE_CLAIM_EXPIRED: message ${messageId} is pending again — the claim behind this ` +
          'token was requeued; discard local work and re-claim via queue_next',
      }
    }
    // Tokenless FIFO bypass: answer/close by id without claiming (CLI parity).
    return { ok: true, expectedClaimedBy: null }
  }

  // rowStatus === 'claimed' from here (terminal is handled by the caller).
  const lease = getLease(messageId)
  if (!lease) {
    if (claimToken !== undefined) {
      // Step (a): claim is not from this process incarnation — even while the
      // row is still claimed and even within the lease window.
      return {
        ok: false,
        error:
          `QUEUE_CLAIM_EXPIRED: no active lease for message ${messageId} in this process — ` +
          'claims do not survive an MCP restart; discard local work and re-claim via queue_next',
      }
    }
    // §7: tokenless finish on someone else's claim (CLI or other worker).
    return {
      ok: false,
      error:
        `QUEUE_NOT_CLAIMER: message ${messageId} is claimed by another owner (CLI or another ` +
        'process); the MCP never finishes claims it did not issue — use CLI requeue if stuck',
    }
  }
  if (claimToken === undefined || claimToken !== lease.claimToken) {
    // Step (b): entry present but supplied token missing or mismatching.
    return {
      ok: false,
      error: `QUEUE_NOT_CLAIMER: claim_token does not match the active lease for message ${messageId}`,
    }
  }
  // Step (c) is the caller's atomic DB check against this exact value.
  return { ok: true, expectedClaimedBy: lease.claimedBy }
}
