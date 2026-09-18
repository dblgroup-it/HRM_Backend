/**
 * What still stands between a candidate and HR's final sign-off.
 *
 * Final verification is the hard-to-undo step: it closes the hire and rejects
 * every other applicant still in the requisition. It should not be possible to
 * take it with a document missing and nobody noticing — but HR does collect
 * papers by hand, so the requirement is waivable, not absolute. The two skip
 * stamps (`docsSkippedAt`, `verificationSkippedAt`) are that waiver, set from
 * "Checked by Manual on hand".
 */

export interface VerifiableDoc {
  label: string;
  status: string;
}

export interface VerifiableOnboarding {
  docs: VerifiableDoc[];
  docsSkippedAt?: Date | string | null;
  verificationSkippedAt?: Date | string | null;
  medicalStatus?: string | null;
}

/**
 * Required documents nobody has collected yet.
 *
 * A rejected document counts as missing: it was looked at and sent back, so
 * the candidate still owes HR that paper.
 */
export function missingDocs(
  required: readonly string[],
  ob: VerifiableOnboarding,
): string[] {
  if (ob.docsSkippedAt) return [];
  const held = new Set(
    ob.docs.filter((d) => d.status !== 'rejected').map((d) => d.label),
  );
  return required.filter((label) => !held.has(label));
}

/** Collected but still waiting on HR to look at them. */
export function pendingDocs(ob: VerifiableOnboarding): string[] {
  if (ob.verificationSkippedAt) return [];
  return ob.docs.filter((d) => d.status === 'pending').map((d) => d.label);
}

/** Documents HR looked at and sent back. */
export function rejectedDocs(ob: VerifiableOnboarding): string[] {
  if (ob.docsSkippedAt) return [];
  return ob.docs.filter((d) => d.status === 'rejected').map((d) => d.label);
}

/**
 * The one reason final verification cannot proceed, or null.
 *
 * Returns a single sentence naming what is outstanding, because that is what
 * HR needs to act on — a list of codes would just be read back to them.
 */
export function hrVerifyBlocker(
  required: readonly string[],
  ob: VerifiableOnboarding,
): string | null {
  if (ob.medicalStatus !== 'cleared') {
    return 'Medical clearance is required before HR final verification';
  }
  const missing = missingDocs(required, ob);
  if (missing.length) {
    return `Still waiting on ${missing.length} document${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Collect them, or record that you checked them by hand.`;
  }
  const pending = pendingDocs(ob);
  if (pending.length) {
    return `${pending.length} document${pending.length > 1 ? 's have' : ' has'} not been verified yet: ${pending.join(', ')}. Verify them, or record that you checked them by hand.`;
  }
  return null;
}
