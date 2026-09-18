import {
  hrVerifyBlocker,
  missingDocs,
  pendingDocs,
  rejectedDocs,
} from './hr-verify';

const REQUIRED = ['National ID / Passport', 'Address Proof'];
const doc = (label: string, status = 'verified') => ({ label, status });
const ob = (over: Partial<Parameters<typeof hrVerifyBlocker>[1]> = {}) => ({
  docs: [],
  medicalStatus: 'cleared',
  ...over,
});

describe('missingDocs', () => {
  it('names what has not arrived', () => {
    expect(missingDocs(REQUIRED, ob({ docs: [doc('Address Proof')] }))).toEqual(
      ['National ID / Passport'],
    );
  });

  it('counts a rejected document as still owed', () => {
    expect(
      missingDocs(
        REQUIRED,
        ob({
          docs: [
            doc('Address Proof'),
            doc('National ID / Passport', 'rejected'),
          ],
        }),
      ),
    ).toEqual(['National ID / Passport']);
  });

  it('waives collection once HR records they checked them by hand', () => {
    expect(missingDocs(REQUIRED, ob({ docsSkippedAt: new Date() }))).toEqual(
      [],
    );
  });
});

describe('pendingDocs', () => {
  it('lists what HR has not looked at', () => {
    expect(
      pendingDocs(ob({ docs: [doc('Address Proof', 'pending')] })),
    ).toEqual(['Address Proof']);
  });

  it('is empty once verification is waived', () => {
    expect(
      pendingDocs(
        ob({
          docs: [doc('Address Proof', 'pending')],
          verificationSkippedAt: new Date(),
        }),
      ),
    ).toEqual([]);
  });
});

describe('rejectedDocs', () => {
  it('lists what was sent back', () => {
    expect(
      rejectedDocs(ob({ docs: [doc('Address Proof', 'rejected')] })),
    ).toEqual(['Address Proof']);
  });
});

describe('hrVerifyBlocker', () => {
  const complete = ob({ docs: REQUIRED.map((l) => doc(l)) });

  it('lets a complete file through', () => {
    expect(hrVerifyBlocker(REQUIRED, complete)).toBeNull();
  });

  it('stops on medical before anything else — it is the harder gate', () => {
    expect(
      hrVerifyBlocker(REQUIRED, { ...complete, medicalStatus: 'pending' }),
    ).toContain('Medical clearance');
  });

  it('names the missing documents rather than just refusing', () => {
    const msg = hrVerifyBlocker(REQUIRED, ob({ docs: [doc('Address Proof')] }));
    expect(msg).toContain('National ID / Passport');
    expect(msg).toContain('checked them by hand');
  });

  it('agrees in number when only one document is missing', () => {
    const msg = hrVerifyBlocker(
      REQUIRED,
      ob({ docs: [doc('Address Proof')] }),
    )!;
    expect(msg).toContain('1 document:');
    expect(msg).not.toContain('1 documents');
  });

  it('blocks on documents nobody has verified', () => {
    const msg = hrVerifyBlocker(
      REQUIRED,
      ob({
        docs: [doc('Address Proof', 'pending'), doc('National ID / Passport')],
      }),
    );
    expect(msg).toContain('has not been verified');
    expect(msg).toContain('Address Proof');
  });

  it('lets both waivers through together', () => {
    expect(
      hrVerifyBlocker(
        REQUIRED,
        ob({ docsSkippedAt: new Date(), verificationSkippedAt: new Date() }),
      ),
    ).toBeNull();
  });
});
