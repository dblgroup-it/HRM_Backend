import {
  JOINING_DOCS,
  LEGACY_LABEL_TO_KEY,
  REQUIRED_DOC_KEYS,
  SIGNATURE_DOC_KEY,
  docLabel,
  docSpec,
} from './joining-docs';
import { hrVerifyBlocker, missingNidParticulars } from './hr-verify';

describe('joining-document catalogue', () => {
  it('has no duplicate keys', () => {
    const keys = JOINING_DOCS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps certificate and marksheet as separate slots', () => {
    // A candidate routinely has one and not the other; a combined row cannot
    // say which half is missing.
    for (const stem of ['ssc', 'hsc', 'graduation']) {
      expect(docSpec(`${stem}_certificate`)).not.toBeNull();
      expect(docSpec(`${stem}_marksheet`)).not.toBeNull();
    }
  });

  it('does not require anything a candidate may simply not have', () => {
    const optional = [
      'post_graduation_certificate',
      'post_graduation_marksheet',
      'professional_cert',
      'training_certificates',
      'experience_certificates',
      'relieving_letter',
      'last_pay_slip',
      'tin_copy',
      'tax_return',
      'salary_certificate',
    ];
    for (const key of optional) {
      expect(docSpec(key)?.required).toBe(false);
    }
  });

  it('still requires the signature — every later form signs with it', () => {
    expect(REQUIRED_DOC_KEYS).toContain(SIGNATURE_DOC_KEY);
  });

  it('marks the photographs as needing a hard copy too', () => {
    expect(docSpec('passport_photos')?.hardCopy).toBe(true);
  });

  it('lets the candidate add as many professional certs as they hold', () => {
    expect(docSpec('professional_cert')?.repeatable).toBe(true);
  });

  it('maps every legacy label onto a real slot', () => {
    for (const key of Object.values(LEGACY_LABEL_TO_KEY)) {
      // code_of_conduct is filed like a document but is not on the checklist.
      if (key === 'code_of_conduct') continue;
      expect(docSpec(key)).not.toBeNull();
    }
  });

  it('reports a missing required slot by its label, not its key', () => {
    const msg = hrVerifyBlocker(
      ['ssc_certificate'],
      { docs: [], medicalStatus: 'cleared' },
      docLabel,
    );
    expect(msg).toContain('SSC Certificate');
    expect(msg).not.toContain('ssc_certificate');
  });
});

describe('NID particulars', () => {
  const cleared = { docs: [], medicalStatus: 'cleared' };

  it('names each field the candidate left blank', () => {
    expect(
      missingNidParticulars({
        ...cleared,
        nidName: 'Arafat Haque Alvi',
        nidAddress: '',
        nidDob: null,
        nidNumber: '1234567890',
      }),
    ).toEqual(['address', 'date of birth']);
  });

  it('is satisfied when all four are filled in', () => {
    expect(
      missingNidParticulars({
        ...cleared,
        nidName: 'Arafat Haque Alvi',
        nidAddress: 'Gopalpur, Nabinagar',
        nidDob: new Date('1995-03-02T00:00:00Z'),
        nidNumber: '1234567890',
      }),
    ).toEqual([]);
  });

  it('blocks final verification while they are incomplete', () => {
    const msg = hrVerifyBlocker([], { ...cleared, nidName: '' }, docLabel);
    expect(msg).toContain('NID details are incomplete');
  });

  it('is waived by "Checked by Manual on hand"', () => {
    expect(
      missingNidParticulars({ ...cleared, nidName: '', docsSkippedAt: new Date() }),
    ).toEqual([]);
  });

  it('does not fire for a caller that never supplied them', () => {
    expect(missingNidParticulars(cleared)).toEqual([]);
  });
});
