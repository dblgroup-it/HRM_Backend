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
  /** The catalogue slot this fills; null for anything filed off-catalogue. */
  docKey?: string | null;
  label: string;
  status: string;
}

export interface VerifiableOnboarding {
  docs: VerifiableDoc[];
  docsSkippedAt?: Date | string | null;
  verificationSkippedAt?: Date | string | null;
  medicalStatus?: string | null;
  /**
   * The candidate's own NID particulars.
   *
   * `undefined` means the caller did not ask — older callers and the tests —
   * and must not fail a gate they know nothing about. An empty string is a
   * field that was asked for and left blank.
   */
  nidName?: string | null;
  nidAddress?: string | null;
  nidDob?: Date | string | null;
  nidNumber?: string | null;
  /**
   * How many reference checks have been recorded for this candidate.
   *
   * At least one is required. A reference check is the last chance to find
   * out something the paperwork cannot tell you, and it is worthless taken
   * after the hire is closed — final verification rejects every other
   * applicant on the requisition, so this is the point of no return.
   *
   * Waived by the same "Checked by Manual on hand" stamp as the documents:
   * DBL does take references by phone, and a gate with no waiver is one
   * people route around rather than satisfy.
   */
  referenceCheckCount?: number;
}

/**
 * Required documents nobody has collected yet.
 *
 * A rejected document counts as missing: it was looked at and sent back, so
 * the candidate still owes HR that paper.
 */
export function missingDocs(
  requiredKeys: readonly string[],
  ob: VerifiableOnboarding,
  /** How a key is named when it has to be reported. */
  label: (key: string) => string = (k) => k,
): string[] {
  if (ob.docsSkippedAt) return [];
  const held = new Set(
    ob.docs
      .filter((d) => d.status !== 'rejected')
      .map((d) => d.docKey)
      .filter((k): k is string => Boolean(k)),
  );
  return requiredKeys.filter((key) => !held.has(key)).map(label);
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
  requiredKeys: readonly string[],
  ob: VerifiableOnboarding,
  label: (key: string) => string = (k) => k,
): string | null {
  if (ob.medicalStatus !== 'cleared') {
    return 'Medical clearance is required before HR final verification';
  }
  const missing = missingDocs(requiredKeys, ob, label);
  if (missing.length) {
    return `Still waiting on ${missing.length} document${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Collect them, or record that you checked them by hand.`;
  }
  const pending = pendingDocs(ob);
  if (pending.length) {
    return `${pending.length} document${pending.length > 1 ? 's have' : ' has'} not been verified yet: ${pending.join(', ')}. Verify them, or record that you checked them by hand.`;
  }
  const nid = missingNidParticulars(ob);
  if (nid.length) {
    return `The candidate's NID details are incomplete — ${nid.join(', ')} ${nid.length > 1 ? 'are' : 'is'} missing. These print on the appointment letter and the payroll record.`;
  }
  if (!referenceChecked(ob)) {
    return 'No reference check has been recorded. Add at least one, or record that you checked them by hand.';
  }
  return null;
}

/**
 * Has anybody taken up a reference, or been excused from it?
 *
 * The docs waiver covers this too. `referenceCheckCount` being undefined
 * means the caller did not ask about reference checks at all — older callers
 * and the tests — and those must not start failing a gate they never knew
 * about, so an absent count is treated as satisfied rather than as zero.
 */
export function referenceChecked(ob: VerifiableOnboarding): boolean {
  if (ob.docsSkippedAt) return true;
  return ob.referenceCheckCount === undefined || ob.referenceCheckCount > 0;
}

/**
 * NID particulars the candidate has not typed in.
 *
 * Typed rather than read off the scan: these four go onto the appointment
 * letter and the payroll record, and an OCR misread of a Bengali name or one
 * digit of the NID number is not something anybody catches from a thumbnail.
 *
 * Waived by the documents stamp, like everything else here — HR does take
 * these off the card by hand.
 */
export function missingNidParticulars(ob: VerifiableOnboarding): string[] {
  if (ob.docsSkippedAt) return [];
  const want: [keyof VerifiableOnboarding, string][] = [
    ['nidName', 'name as per NID'],
    ['nidAddress', 'address'],
    ['nidDob', 'date of birth'],
    ['nidNumber', 'NID number'],
  ];
  return want
    .filter(([field]) => {
      const v = ob[field];
      return v === undefined ? false : !v;
    })
    .map(([, name]) => name);
}
