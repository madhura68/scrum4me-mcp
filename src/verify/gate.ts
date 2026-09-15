export type VerifyRequired = 'ALIGNED' | 'ALIGNED_OR_PARTIAL' | 'ANY'

const SUMMARY_MIN_LENGTH = 20

/**
 * Validate whether a CLAIMED/RUNNING job can transition to DONE based on its
 * verify_result + the task's verify_required level.
 *
 * Decision matrix:
 *   verifyResult=null        → reject (run verify_task_against_plan first)
 *   EMPTY  + !verify_only    → reject
 *   EMPTY  + verify_only     → allowed
 *   ALIGNED                  → always allowed
 *   PARTIAL/DIVERGENT
 *     required=ALIGNED       → reject (strict task)
 *     required=ALIGNED_OR_PARTIAL → require non-empty summary explaining drift
 *     required=ANY           → allowed (refactor/multi-file edit)
 */
export function checkVerifyGate(
  verifyResult: string | null,
  verifyOnly: boolean,
  verifyRequired: VerifyRequired = 'ALIGNED_OR_PARTIAL',
  summary: string | undefined = undefined,
): { allowed: true } | { allowed: false; error: string } {
  if (verifyResult === null) {
    return {
      allowed: false,
      error: 'Roep eerst verify_task_against_plan aan voordat je DONE markeert.',
    }
  }
  if (verifyResult === 'EMPTY') {
    if (verifyOnly) return { allowed: true }
    return {
      allowed: false,
      error:
        'Plan-vs-implementatie verify gaf EMPTY. Geen wijzigingen gedetecteerd. ' +
        'Markeer de task als verify_only of pas de implementatie aan.',
    }
  }
  if (verifyResult === 'ALIGNED') return { allowed: true }

  // PARTIAL or DIVERGENT
  if (verifyRequired === 'ANY') return { allowed: true }
  if (verifyRequired === 'ALIGNED') {
    return {
      allowed: false,
      error:
        `Plan vereist ALIGNED maar verify gaf ${verifyResult}. ` +
        `Pas de implementatie aan zodat alle plan-paden zijn afgedekt, ` +
        `of stel verify_required in op ALIGNED_OR_PARTIAL/ANY.`,
    }
  }
  // verifyRequired === 'ALIGNED_OR_PARTIAL': vereist summary
  if (!summary || summary.trim().length < SUMMARY_MIN_LENGTH) {
    return {
      allowed: false,
      error:
        `Verify gaf ${verifyResult}. Geef een summary (≥${SUMMARY_MIN_LENGTH} chars) die uitlegt ` +
        `waarom de implementatie afwijkt van het plan, of stel verify_required in op ANY.`,
    }
  }
  return { allowed: true }
}

