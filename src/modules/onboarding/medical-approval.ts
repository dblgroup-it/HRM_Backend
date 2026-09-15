/**
 * What the Central Medical Officer's decision does to a medical record.
 *
 * Pure, and separate from the service, because this is the rule the whole layer
 * exists for: a candidate is not medically cleared until someone other than the
 * examining officer says so. Getting it wrong either stalls a hire or clears
 * someone nobody reviewed, and neither is visible in a screenshot.
 */

/** What the examining officer can put forward. Never `pending` or `submitted`. */
export type ProposedMedical = 'cleared' | 'rejected';

export type CmoDecision =
  /** Confirm the examining officer's finding, whatever it was. */
  | 'approve'
  /** Overturn it: this candidate is not medically cleared. */
  | 'reject'
  /** Send it back to the examining officer to correct or re-test. */
  | 'return';

export interface MedicalTransition {
  /** The resulting `medicalStatus`. */
  status: 'pending' | 'cleared' | 'rejected';
  /** True when the record leaves the CMO queue decided. */
  decided: boolean;
  /** Human wording for the notification and the activity log. */
  summary: string;
}

/**
 * A note is required whenever the CMO does something other than agree.
 *
 * Overturning or returning reverses a clinician's written finding, and the
 * examining officer has to be told why — "rejected" with no reason is an
 * argument waiting to happen, and there is no other record of the reasoning.
 * Approving needs no note: the finding already states it.
 */
export function decisionNoteError(
  decision: CmoDecision,
  note: string | null | undefined,
): string | null {
  if (decision === 'approve') return null;
  if ((note ?? '').trim().length >= 3) return null;
  return decision === 'reject'
    ? 'Give a reason for overturning the medical finding.'
    : 'Say what the examining officer needs to correct or re-check.';
}

/**
 * Where a submission lands once the CMO has decided.
 *
 * `approve` applies what was proposed — including a proposed rejection, which
 * is why the layer covers unfit results as well as fit ones. To overturn a
 * proposed rejection into a clearance, the CMO returns it with a note and the
 * officer resubmits: a clearance should carry the examining officer's name, not
 * be conjured by someone who did not run the exam.
 */
export function applyCmoDecision(
  decision: CmoDecision,
  proposed: ProposedMedical,
): MedicalTransition {
  switch (decision) {
    case 'approve':
      return {
        status: proposed,
        decided: true,
        summary:
          proposed === 'cleared'
            ? 'Medical cleared — confirmed by the Central Medical Officer.'
            : 'Medical rejected — confirmed by the Central Medical Officer.',
      };
    case 'reject':
      return {
        status: 'rejected',
        decided: true,
        summary:
          proposed === 'cleared'
            ? 'Medical rejected — the Central Medical Officer overturned a proposed clearance.'
            : 'Medical rejected — confirmed by the Central Medical Officer.',
      };
    case 'return':
      return {
        status: 'pending',
        decided: false,
        summary:
          'Returned to the examining officer by the Central Medical Officer.',
      };
  }
}

/**
 * Why a record cannot be decided on, or null when it can.
 *
 * Checked per record rather than per request, because a bulk approval is a
 * list of independent decisions — one candidate having been handled by another
 * CMO in the meantime must not fail the other forty.
 */
export function submissionBlocker(record: {
  medicalStatus: string;
  medicalProposed: string | null;
}): string | null {
  if (record.medicalStatus !== 'submitted') {
    return record.medicalStatus === 'pending'
      ? 'No medical finding has been submitted for this candidate.'
      : `This medical is already ${record.medicalStatus}.`;
  }
  if (
    record.medicalProposed !== 'cleared' &&
    record.medicalProposed !== 'rejected'
  ) {
    // Only reachable if a submission was written without a proposal, which the
    // service prevents — but a bulk action must not crash on one bad row.
    return 'This submission has no recorded finding to confirm.';
  }
  return null;
}
