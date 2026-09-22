import { buildCandidateBrief } from './candidate-brief';

/**
 * The brief an interviewer marks against.
 *
 * Every figure here is printed beside a score, so the ways it can be wrong
 * matter: a job with no end date is still running (and its span is measured
 * to today, not to zero), an age is whole years and not "the year minus the
 * year", and a candidate typed in by hand has no CV profile at all and must
 * not produce a card full of blanks.
 */
describe('buildCandidateBrief', () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    source: 'bdjobs',
    capturedAt: '2026-01-01T00:00:00.000Z',
    personal: { fullName: 'Asanka Alwis', dateOfBirth: '1982-03-15' },
    contact: {
      phone: '+880 1712345678',
      currentAddress: 'House 33, Sector 7, Uttara, Dhaka-1230',
    },
    employment: [],
    education: [],
    compensation: {},
    summary: { currentlyEmployed: true, totalExperienceLabel: '22 years' },
    ...over,
  });

  it('reads contact, age and total service off the stored profile', () => {
    const brief = buildCandidateBrief({
      name: 'Asanka Alwis',
      email: null,
      phone: null,
      cvProfile: profile(),
    });

    expect(brief.phone).toBe('+880 1712345678');
    expect(brief.address).toBe('House 33, Sector 7, Uttara, Dhaka-1230');
    expect(brief.totalService).toBe('22 years');
    expect(brief.empty).toBe(false);
    // Whole years, and not merely this year minus the birth year.
    jest.useFakeTimers().setSystemTime(new Date('2026-03-14T09:00:00.000Z'));
    expect(buildCandidateBrief({ name: 'x', cvProfile: profile() }).age).toBe(
      43,
    );
    jest.setSystemTime(new Date('2026-03-15T09:00:00.000Z'));
    expect(buildCandidateBrief({ name: 'x', cvProfile: profile() }).age).toBe(
      44,
    );
    jest.useRealTimers();
  });

  it('prefers the candidate record over the CV for contact details', () => {
    const brief = buildCandidateBrief({
      name: 'Asanka Alwis',
      phone: '01999999999',
      email: 'hr@dbl-group.com',
      cvAddress: 'Mirpur, Dhaka',
      cvProfile: profile(),
    });
    // What HR typed into the candidate is what HR will dial.
    expect(brief.phone).toBe('01999999999');
    expect(brief.email).toBe('hr@dbl-group.com');
    expect(brief.address).toBe('Mirpur, Dhaka');
  });

  it('measures a current job to today and a finished one to its end date', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-22T00:00:00.000Z'));
    const brief = buildCandidateBrief({
      name: 'Asanka Alwis',
      cvProfile: profile({
        employment: [
          {
            company: 'Wear Sphere Garments LLC',
            designation: 'Head of Operation & Quality',
            from: '2025-01-01',
            current: true,
          },
          {
            company: 'PT. Hoplun Indonesia',
            designation: 'Head of Quality',
            from: '2020-11-13',
            to: '2023-02-28',
            current: false,
          },
        ],
      }),
    });
    jest.useRealTimers();

    expect(brief.employment[0]).toMatchObject({
      company: 'Wear Sphere Garments LLC',
      period: 'Jan 2025 – Present',
      duration: '1.7 Yrs.',
      current: true,
    });
    expect(brief.employment[1]).toMatchObject({
      period: 'Nov 2020 – Feb 2023',
      duration: '2.3 Yrs.',
      current: false,
    });
  });

  it('puts the most recent qualification first', () => {
    const brief = buildCandidateBrief({
      name: 'Asanka Alwis',
      cvProfile: profile({
        education: [
          { institute: 'GIMI, Colombo', degree: 'Diploma', passYear: 2003 },
          {
            institute: 'University of Bedfordshire',
            degree: 'MBA',
            passYear: 2020,
          },
        ],
      }),
    });
    expect(brief.education.map((e) => e.degree)).toEqual(['MBA', 'Diploma']);
  });

  it('says so plainly when there is no CV profile at all', () => {
    // A candidate a recruiter typed in by hand. The card renders nothing
    // rather than a scaffold of empty headings.
    const brief = buildCandidateBrief({ name: 'Walk-in applicant' });
    expect(brief.empty).toBe(true);
    expect(brief.education).toEqual([]);
    expect(brief.employment).toEqual([]);
    expect(brief.age).toBeNull();
  });

  it('survives a profile written by an older mapper', () => {
    // The column is JSON from whenever the CV arrived — half a shape, or the
    // wrong shape entirely, must not throw on an evaluation form.
    expect(() =>
      buildCandidateBrief({ name: 'x', cvProfile: { summary: 'not an object' } }),
    ).not.toThrow();
    expect(buildCandidateBrief({ name: 'x', cvProfile: 'nonsense' }).empty).toBe(
      true,
    );
    const partial = buildCandidateBrief({
      name: 'x',
      cvProfile: { employment: [{ company: '  Beximco  ', current: false }] },
    });
    expect(partial.employment[0]).toMatchObject({
      company: 'Beximco',
      period: null,
      duration: null,
    });
  });
});
