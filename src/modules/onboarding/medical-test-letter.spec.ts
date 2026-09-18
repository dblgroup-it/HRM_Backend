import {
  appointmentText,
  bandFromDateOfBirth,
  buildCandidateMedicalEmail,
  buildMedicalTestLetter,
  testsFor,
} from './medical-test-letter';

/** Strip tags so an assertion reads the letter, not the markup. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const base = {
  candidateName: 'Test Candidate',
  salutation: 'Mr.',
  unitName: 'Hamza Textiles Ltd. (Washing Unit)',
  refNo: 'DBL/Corp/HR/MT - 7126/26',
  examAt: new Date('2026-08-29T10:30:00'),
  letterDate: new Date('2026-08-16T09:00:00'),
};

describe('testsFor — the two lists differ in substance', () => {
  it('lists seven tests below forty', () => {
    expect(testsFor('below_40')).toHaveLength(7);
  });

  it('lists eight at forty and above, S/Creatinine being the extra', () => {
    const over = testsFor('above_40');
    expect(over).toHaveLength(8);
    expect(over).toContain('S/Creatinine');
    expect(testsFor('below_40')).not.toContain('S/Creatinine');
  });

  it('keeps the shared seven in the same order in both', () => {
    // The clinic reads these as a checklist; reordering them between versions
    // would make two letters for the same candidate look like different tests.
    const under = testsFor('below_40');
    const over = testsFor('above_40');
    expect(over.slice(0, 6)).toEqual(under.slice(0, 6));
  });
});

describe('bandFromDateOfBirth', () => {
  const now = new Date('2026-08-16T00:00:00');

  it('puts a 42-year-old in the older band', () => {
    expect(bandFromDateOfBirth('1984-03-12', now)).toBe('above_40');
  });

  it('puts a 30-year-old in the younger band', () => {
    expect(bandFromDateOfBirth('1996-01-01', now)).toBe('below_40');
  });

  it('treats the fortieth birthday itself as the older band', () => {
    expect(bandFromDateOfBirth('1986-08-16', now)).toBe('above_40');
  });

  it('does not round up the day before that birthday', () => {
    // Off by one here means an extra test, or a missing one.
    expect(bandFromDateOfBirth('1986-08-17', now)).toBe('below_40');
  });

  it('returns null when there is no usable date', () => {
    // Bdjobs applicants frequently have none; guessing would skip or invent a
    // test, so the caller asks HR instead.
    expect(bandFromDateOfBirth(null, now)).toBeNull();
    expect(bandFromDateOfBirth('', now)).toBeNull();
    expect(bandFromDateOfBirth('not a date', now)).toBeNull();
    expect(bandFromDateOfBirth('1820-01-01', now)).toBeNull();
  });
});

describe('appointmentText', () => {
  it('reads the way the draft does', () => {
    expect(appointmentText(new Date('2026-08-29T10:30:00'))).toBe(
      '29-Aug-2026 (Saturday) at 10.30 AM',
    );
  });

  it('handles an afternoon slot', () => {
    expect(appointmentText(new Date('2026-08-29T14:05:00'))).toContain(
      '02.05 PM',
    );
  });
});

describe('buildMedicalTestLetter', () => {
  it('addresses the clinic and carries the reference', () => {
    const body = text(buildMedicalTestLetter({ ...base, band: 'above_40' }));
    expect(body).toContain('Medical and Health Care Services');
    expect(body).toContain('DBL/Corp/HR/MT - 7126/26');
    expect(body).toContain('August 16, 2026');
  });

  it('names the candidate and their unit as the paper letter does', () => {
    const body = text(buildMedicalTestLetter({ ...base, band: 'above_40' }));
    expect(body).toContain(
      'Mr. Test Candidate, Unit - Hamza Textiles Ltd. (Washing Unit)',
    );
  });

  it('signs over Group HR for the older band', () => {
    expect(
      text(buildMedicalTestLetter({ ...base, band: 'above_40' })),
    ).toContain('Group Human Resources');
  });

  it('signs over Corporate HR for the younger band', () => {
    const body = text(buildMedicalTestLetter({ ...base, band: 'below_40' }));
    expect(body).toContain('Corporate Human Resources');
    expect(body).not.toContain('Group Human Resources');
  });

  it('states which list is being used', () => {
    expect(
      text(buildMedicalTestLetter({ ...base, band: 'above_40' })),
    ).toContain('40 years & above age level');
    expect(
      text(buildMedicalTestLetter({ ...base, band: 'below_40' })),
    ).toContain('below 40 years');
  });

  it('numbers every test', () => {
    const body = text(buildMedicalTestLetter({ ...base, band: 'above_40' }));
    for (let i = 1; i <= 8; i++) expect(body).toContain(`${i}.`);
  });

  it('carries the appointment', () => {
    const body = text(buildMedicalTestLetter({ ...base, band: 'below_40' }));
    expect(body).toContain('29-Aug-2026 (Saturday) at 10.30 AM');
  });

  it('names the venue, the same one the candidate is given', () => {
    expect(
      text(buildMedicalTestLetter({ ...base, band: 'below_40' })),
    ).toContain('Jinnat Complex, Kashimpur, Gazipur');
  });

  it('escapes markup rather than emitting it', () => {
    const html = buildMedicalTestLetter({
      ...base,
      band: 'below_40',
      candidateName: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
  });
});

describe('buildCandidateMedicalEmail', () => {
  const mail = buildCandidateMedicalEmail({ examAt: base.examAt });

  it('tells them when and where', () => {
    // The address is a constant, not a per-send field — one building, every
    // time, so it cannot be retyped wrong onto somebody's letter.
    expect(mail.text).toContain('29-Aug-2026 (Saturday) at 10.30 AM');
    expect(mail.text).toContain('Jinnat Complex, Kashimpur, Gazipur');
  });

  it('lists all eight documents to bring', () => {
    for (let i = 1; i <= 8; i++) expect(mail.text).toContain(`${i}.`);
    expect(mail.text).toContain('Four Passport size photographs');
    expect(mail.text).toContain('Relieving letter');
  });

  it('does NOT list the medical tests', () => {
    // The test list is the clinic's business. Printing it here invites a
    // candidate to arrive having decided which tests they need.
    expect(mail.text).not.toContain('S/Creatinine');
    expect(mail.text).not.toContain('HBs Ag');
    expect(text(mail.html)).not.toContain('Blood Grouping');
  });

  it('signs as Corporate HR', () => {
    expect(mail.text).toContain('DBL Corporate HR');
  });
});

describe('the venue is the same on both', () => {
  it('names one place, so the clinic and the candidate cannot disagree', () => {
    // Two addresses for one appointment is how somebody ends up in the wrong
    // town on the right day.
    const letter = text(buildMedicalTestLetter({ ...base, band: 'above_40' }));
    const candidate = buildCandidateMedicalEmail({ examAt: base.examAt }).text;
    expect(letter).toContain('Jinnat Complex, Kashimpur, Gazipur');
    expect(candidate).toContain('Jinnat Complex, Kashimpur, Gazipur');
  });
});
