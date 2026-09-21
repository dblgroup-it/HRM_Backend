import {
  hrVerifyBlocker,
  missingDocs,
  pendingDocs,
  rejectedDocs,
} from './hr-verify';

/**
 * Documents are matched on their catalogue key now, not their label — the
 * label is free text and, for the repeatable slots, is whatever the candidate
 * typed. These fixtures use keys and report through a label function, the way
 * the service does.
 */
const REQUIRED = ['nid_or_passport', 'residence_proof'];
const LABELS: Record<string, string> = {
  nid_or_passport: 'National ID / Passport',
  residence_proof: 'Address Proof',
};
const label = (k: string) => LABELS[k] ?? k;
const doc = (docKey: string, status = 'verified') => ({
  docKey,
  label: label(docKey),
  status,
});
const ob = (over: Partial<Parameters<typeof hrVerifyBlocker>[1]> = {}) => ({
  docs: [],
  medicalStatus: 'cleared',
  ...over,
});

describe('missingDocs', () => {
  it('names what has not arrived', () => {
    expect(missingDocs(REQUIRED, ob({ docs: [doc('residence_proof')] }), label)).toEqual(
      ['National ID / Passport'],
    );
  });

  it('counts a rejected document as still owed', () => {
    expect(
      missingDocs(REQUIRED, ob({
          docs: [
            doc('residence_proof'),
            doc('nid_or_passport', 'rejected'),
          ],
        }), label),
    ).toEqual(['National ID / Passport']);
  });

  it('waives collection once HR records they checked them by hand', () => {
    expect(missingDocs(REQUIRED, ob({ docsSkippedAt: new Date() }), label)).toEqual(
      [],
    );
  });
});

describe('pendingDocs', () => {
  it('lists what HR has not looked at', () => {
    expect(
      pendingDocs(ob({ docs: [doc('residence_proof', 'pending')] })),
    ).toEqual(['Address Proof']);
  });

  it('is empty once verification is waived', () => {
    expect(
      pendingDocs(
        ob({
          docs: [doc('residence_proof', 'pending')],
          verificationSkippedAt: new Date(),
        }),
      ),
    ).toEqual([]);
  });
});

describe('rejectedDocs', () => {
  it('lists what was sent back', () => {
    expect(
      rejectedDocs(ob({ docs: [doc('residence_proof', 'rejected')] })),
    ).toEqual(['Address Proof']);
  });
});

describe('hrVerifyBlocker', () => {
  const complete = ob({ docs: REQUIRED.map((l) => doc(l)) });

  it('lets a complete file through', () => {
    expect(hrVerifyBlocker(REQUIRED, complete, label)).toBeNull();
  });

  it('stops on medical before anything else — it is the harder gate', () => {
    expect(
      hrVerifyBlocker(REQUIRED, { ...complete, medicalStatus: 'pending' }, label),
    ).toContain('Medical clearance');
  });

  it('names the missing documents rather than just refusing', () => {
    const msg = hrVerifyBlocker(REQUIRED, ob({ docs: [doc('residence_proof')] }), label);
    expect(msg).toContain('National ID / Passport');
    expect(msg).toContain('checked them by hand');
  });

  it('agrees in number when only one document is missing', () => {
    const msg = hrVerifyBlocker(REQUIRED, ob({ docs: [doc('residence_proof')] }), label)!;
    expect(msg).toContain('1 document:');
    expect(msg).not.toContain('1 documents');
  });

  it('blocks on documents nobody has verified', () => {
    const msg = hrVerifyBlocker(REQUIRED, ob({
        docs: [doc('residence_proof', 'pending'), doc('nid_or_passport')],
      }), label);
    expect(msg).toContain('has not been verified');
    expect(msg).toContain('Address Proof');
  });

  it('lets both waivers through together', () => {
    expect(
      hrVerifyBlocker(REQUIRED, ob({ docsSkippedAt: new Date(), verificationSkippedAt: new Date() }), label),
    ).toBeNull();
  });
});

describe('reference checks at final verification', () => {
  const ready = {
    docs: [doc('passport_photos')],
    medicalStatus: 'cleared',
  };

  it('refuses when no reference check has been recorded', () => {
    expect(
      hrVerifyBlocker(['passport_photos'], {
        ...ready,
        referenceCheckCount: 0,
      }),
    ).toMatch(/reference check/i);
  });

  it('passes once one has been recorded', () => {
    expect(
      hrVerifyBlocker(['passport_photos'], {
        ...ready,
        referenceCheckCount: 1,
      }),
    ).toBeNull();
  });

  it('is waived by "Checked by Manual on hand", like the documents', () => {
    expect(
      hrVerifyBlocker(['passport_photos'], {
        ...ready,
        referenceCheckCount: 0,
        docsSkippedAt: new Date(),
      }),
    ).toBeNull();
  });

  it('does not fire for a caller that never supplied a count', () => {
    // Older callers and the tests above pass no count at all. They must not
    // start failing a gate they do not know exists.
    expect(hrVerifyBlocker(['passport_photos'], ready)).toBeNull();
  });
});
