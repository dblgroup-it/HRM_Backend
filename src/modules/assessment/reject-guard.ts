/**
 * May the interview panel record a rejection for this candidate?
 *
 * Pulled out of the service so the rule can be read and tested on its own —
 * it got this wrong twice. The two failures it sits between:
 *
 *  - Too loose: rejecting somebody whose hire had completed left a file that
 *    was onboarded and rejected at once, which no screen can render honestly.
 *  - Too tight: refusing on the mere existence of an onboarding row meant a
 *    candidate who was hired, had it unwound, and is now being re-interviewed
 *    could never be rejected — including anyone marked absent and rescheduled.
 *
 * So both halves must agree: the candidate's own stage says a hire is in
 * flight, AND there is an onboarding record that has actually moved.
 */
export interface RejectGuardInput {
  name: string;
  stage: string;
  onboarding: { status: string; offerSentAt: Date | string | null } | null;
}

export function rejectBlocker(c: RejectGuardInput): string | null {
  if (c.stage === 'REJECTED') return `${c.name} has already been rejected.`;
  if (c.stage === 'SELECTED') {
    return `${c.name} has already been selected. Undo that before rejecting them.`;
  }
  // Only at FINAL does an onboarding row mean a hire is genuinely running.
  // Anything earlier is a candidate back in the pipeline.
  if (c.stage !== 'FINAL') return null;
  const ob = c.onboarding;
  const inFlight = ob && (ob.status !== 'docs_pending' || Boolean(ob.offerSentAt));
  if (!inFlight) return null;
  return `${c.name}'s onboarding has already started — an offer is out. Corporate HR has to unwind the hire before they can be rejected here.`;
}
