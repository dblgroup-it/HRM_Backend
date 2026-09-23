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
      period: '13 Nov 2020 – 28 Feb 2023',
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

  it('tells a qualification from a course, the way the sheet prints them', () => {
    const brief = buildCandidateBrief({
      name: 'Asanka Alwis',
      cvProfile: profile({
        education: [
          { institute: 'University of Bedfordshire, UK', degree: 'MBA', passYear: 2020 },
          { institute: 'CQI & IRCA', degree: 'ISO 9001:2015 Lead Auditor', passYear: 2023 },
          { institute: 'BAU', degree: 'Masters Of Science', passYear: 2019 },
          { institute: 'Govt. College', degree: 'Higher Secondary School Certificate', passYear: 2015 },
          { institute: 'Anexas Europe', degree: 'Lean Six Sigma Black Belt', passYear: 2021 },
        ],
      }),
    });
    const kindOf = (degree: string) =>
      brief.education.find((e) => e.degree === degree)?.kind;
    expect(kindOf('MBA')).toBe('degree');
    expect(kindOf('Masters Of Science')).toBe('degree');
    // Spelled out, not abbreviated — a CV writes it both ways.
    expect(kindOf('Higher Secondary School Certificate')).toBe('degree');
    expect(kindOf('ISO 9001:2015 Lead Auditor')).toBe('certification');
    expect(kindOf('Lean Six Sigma Black Belt')).toBe('certification');
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

  it('groups posts by company, the way the shortlisting sheet does', () => {
    const brief = buildCandidateBrief({
      name: 'Asanka Alwis',
      cvProfile: profile({
        summary: {},
        employment: [
          { company: 'SQ Group of Companies', designation: 'Head of Quality', from: '2023-10-10', to: '2024-09-30' },
          { company: 'PT. Hoplun Indonesia', designation: 'Head Of Quality', from: '2020-11-13', to: '2023-02-28' },
          { company: 'SQ Group of Companies.', designation: 'Senior Manager', from: '2014-02-12', to: '2020-03-31' },
        ],
      }),
    });
    expect(brief.companies.map((c) => c.company)).toEqual([
      'SQ Group of Companies',
      'PT. Hoplun Indonesia',
    ]);
    expect(brief.companies[0].roles.map((r) => r.designation)).toEqual([
      'Head of Quality',
      'Senior Manager',
    ]);
    // 11 months + 73 months, the gap between them not counted.
    expect(brief.companies[0].total).toBe('7.0 Yrs.');
  });

  it('adds up total service from the job dates when the CV states none', () => {
    const brief = buildCandidateBrief({
      name: 'X',
      cvProfile: profile({
        summary: {},
        employment: [
          { company: 'A', from: '2010-01-01', to: '2015-01-01' },
          // Overlaps the first by a year — counted once.
          { company: 'B', from: '2014-01-01', to: '2016-07-01' },
        ],
      }),
    });
    expect(brief.totalService).toBe('6 years 6 months');
  });

  it('files a school-leaving certificate as education however it is written', () => {
    const brief = buildCandidateBrief({
      name: 'X',
      cvProfile: profile({
        education: [
          { degree: 'Higher Secondary Certificate Examination (H.S.C)', institute: 'Govt. Pioneer Girls College', passYear: 2016 },
          { degree: 'S.S.C.', institute: 'Some School', passYear: 2014 },
          { degree: 'SQL for Data Science', institute: 'Coursera', passYear: 2020 },
        ],
      }),
    });
    const kinds = Object.fromEntries(brief.education.map((e) => [e.degree, e.kind]));
    expect(kinds['Higher Secondary Certificate Examination (H.S.C)']).toBe('degree');
    expect(kinds['S.S.C.']).toBe('degree');
    expect(kinds['SQL for Data Science']).toBe('certification');
  });
});
