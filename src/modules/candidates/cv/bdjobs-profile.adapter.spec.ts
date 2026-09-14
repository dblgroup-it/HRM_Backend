import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { BdJobsInboundCandidateDto } from '../../integrations/bdjobs/dto/bdjobs-inbound.dto';
import { bdjobsToCvProfile } from './bdjobs-cv.mapper';
import { bdjobsProfileToCandidateData } from './bdjobs-profile.adapter';

/**
 * The shape the live BDJobs job board actually posts.
 *
 * Structurally identical to the payload that was rejected in production —
 * flat `profile`, sixteen overlapping employment rows, twelve qualifications
 * using `passingYear` — with every value replaced by an invented one. Real
 * applicant details do not belong in a repository.
 */
const LIVE_PAYLOAD = {
  jobReferenceId: 'REQ-2026-015',
  bdJobsJobId: '1523119',
  applicationId: '412555319',
  ts: 1789000000,
  candidate: {
    name: 'Test Applicant',
    email: 'test.applicant@example.invalid',
    phone: '+880000000000',
  },
  profile: {
    currentEmployer: 'Alpha Ltd',
    currentDesignation: 'Officer',
    expectedSalary: 0,
    currentSalary: 0,
    highestEducation: 'Example College',
    institution: 'Example College',
    passingYear: 2016,
    presentLocation: 'Dhaka',
    dateOfBirth: '1988-01-01',
    gender: 'Female',
    bdjobsApplicantId: '977824',
    employmentHistory: [
      // Overlapping and still-open, exactly as Bdjobs sends them.
      {
        companyName: 'Alpha Ltd',
        designation: 'Officer',
        role: '',
        fromDate: '02/01/2012',
        toDate: '14/09/2026',
      },
      {
        companyName: 'Beta Ltd',
        designation: 'Executive',
        role: '',
        fromDate: '04/03/2011',
        toDate: '14/09/2026',
      },
      {
        companyName: 'Beta Ltd',
        designation: 'Executive',
        role: '',
        fromDate: '02/11/2001',
        toDate: '14/09/2026',
      },
      // A genuine duplicate of the first row.
      {
        companyName: 'Alpha Ltd',
        designation: 'Officer',
        role: '',
        fromDate: '02/01/2012',
        toDate: '14/09/2026',
      },
      // One that actually ended.
      {
        companyName: 'Gamma Ltd',
        designation: 'Trainee',
        role: '',
        fromDate: '03/03/2012',
        toDate: '01/12/2012',
      },
    ],
    educationHistory: [
      {
        institute: 'Example University',
        university: 'Example University',
        country: 'Bangladesh',
        passingYear: 2011,
        grade: '',
        percentage: '45%',
      },
      {
        institute: 'Example College',
        university: 'Example College',
        country: 'Bangladesh',
        passingYear: 2016,
        grade: '',
        percentage: '45%',
      },
      {
        institute: 'Example School',
        university: 'Example School',
        country: 'Bangladesh',
        passingYear: 2014,
        grade: '',
        percentage: '60%',
      },
    ],
  },
};

/** The same pipe main.ts installs globally. */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});
const meta = {
  type: 'body' as const,
  metatype: BdJobsInboundCandidateDto,
};

describe('BdJobsInboundCandidateDto — the live job board payload', () => {
  it('accepts the profile that production rejected', async () => {
    // Before the fix this threw:
    //   profile.property currentEmployer should not exist; …and eleven more
    await expect(pipe.transform(LIVE_PAYLOAD, meta)).resolves.toBeDefined();
  });

  it('keeps the profile contents instead of whitelisting them away', async () => {
    const out = (await pipe.transform(
      LIVE_PAYLOAD,
      meta,
    )) as BdJobsInboundCandidateDto;

    // Surviving validation is not enough — a stripped profile would import a
    // candidate with no CV and no error anywhere to explain it.
    expect(out.profile?.currentEmployer).toBe('Alpha Ltd');
    expect(Array.isArray(out.profile?.employmentHistory)).toBe(true);
    expect((out.profile?.employmentHistory as unknown[]).length).toBe(5);
    expect((out.profile?.educationHistory as unknown[]).length).toBe(3);
  });

  it('still rejects an unknown key at the top level', async () => {
    // Loosening `profile` must not loosen the envelope around it.
    // BadRequestException's own `message` is the generic status text; the
    // field-by-field detail is in its response body, which is what the caller
    // actually reads.
    expect.assertions(2);
    try {
      await pipe.transform({ ...LIVE_PAYLOAD, somethingElse: 'x' }, meta);
    } catch (err) {
      const res = (err as BadRequestException).getResponse() as {
        message: string | string[];
      };
      expect(err).toBeInstanceOf(BadRequestException);
      expect(String(res.message)).toMatch(/somethingElse/);
    }
  });
});

describe('bdjobsProfileToCandidateData', () => {
  const now = new Date('2026-09-14T00:00:00.000Z');

  it('produces a CV from the flat profile', () => {
    const data = bdjobsProfileToCandidateData(
      LIVE_PAYLOAD.profile,
      LIVE_PAYLOAD.candidate,
    );
    expect(data).not.toBeNull();

    const cv = bdjobsToCvProfile(data!, now);

    expect(cv.personal.fullName).toBe('Test Applicant');
    expect(cv.personal.gender).toBe('Female');
    // ISO in, ISO out — the flat variant does not use dd/MM/yyyy here.
    expect(cv.personal.dateOfBirth).toBe('1988-01-01');
    expect(cv.contact.email).toBe('test.applicant@example.invalid');
    expect(cv.contact.phone).toBe('+880000000000');
    expect(cv.contact.currentLocation).toBe('Dhaka');
  });

  it('reads passingYear, which only the flat variant uses', () => {
    const cv = bdjobsToCvProfile(
      bdjobsProfileToCandidateData(
        LIVE_PAYLOAD.profile,
        LIVE_PAYLOAD.candidate,
      )!,
      now,
    );
    // Reading only `passYear` left every one of these undefined, which blanked
    // the approval sheet's Education column for job-board candidates.
    expect(cv.education.map((e) => e.passYear)).toEqual([2016, 2014, 2011]);
    expect(cv.summary.latestEducation).toContain('2016');
  });

  it('merges overlapping jobs instead of summing them', () => {
    const cv = bdjobsToCvProfile(
      bdjobsProfileToCandidateData(
        LIVE_PAYLOAD.profile,
        LIVE_PAYLOAD.candidate,
      )!,
      now,
    );
    // The duplicate row is gone.
    expect(cv.employment).toHaveLength(4);
    // 2001-11 to 2026-09 is just under 25 years. Adding the five spans instead
    // would claim about 60.
    expect(cv.summary.totalExperienceYears).toBeGreaterThan(24);
    expect(cv.summary.totalExperienceYears).toBeLessThan(25);
    expect(cv.summary.currentlyEmployed).toBe(true);
    expect(cv.summary.lastOrganization).toBeTruthy();
  });

  it('treats a salary of 0 as "not stated", not as earning nothing', () => {
    const cv = bdjobsToCvProfile(
      bdjobsProfileToCandidateData(
        LIVE_PAYLOAD.profile,
        LIVE_PAYLOAD.candidate,
      )!,
      now,
    );
    expect(cv.compensation.current).toBeUndefined();
    expect(cv.compensation.expected).toBeUndefined();
  });

  it('returns null for a profile carrying only identifiers', () => {
    // Integrations that send CandidateData also send a bare profile. Adapting
    // that would store an empty CV over a perfectly good one.
    expect(
      bdjobsProfileToCandidateData({ bdjobsApplicantId: '977824' }),
    ).toBeNull();
    expect(bdjobsProfileToCandidateData(undefined)).toBeNull();
    expect(bdjobsProfileToCandidateData(null)).toBeNull();
  });

  it('keeps the current job and qualification when the histories are absent', () => {
    const data = bdjobsProfileToCandidateData(
      {
        currentEmployer: 'Alpha Ltd',
        currentDesignation: 'Officer',
        institution: 'Example College',
        highestEducation: 'BSc',
        passingYear: 2016,
      },
      { name: 'Test Applicant' },
    );
    const cv = bdjobsToCvProfile(data!, now);

    expect(cv.summary.lastOrganization).toBe('Alpha Ltd');
    expect(cv.summary.lastDesignation).toBe('Officer');
    expect(cv.education[0]).toMatchObject({
      institute: 'Example College',
      degree: 'BSc',
      passYear: 2016,
    });
    // No dates were given, so no experience may be claimed.
    expect(cv.summary.totalExperienceYears).toBeUndefined();
  });

  it('does not repeat the school as its own degree', () => {
    // Bdjobs fills highestEducation with the institution more often than not.
    const data = bdjobsProfileToCandidateData(
      { institution: 'Example College', highestEducation: 'Example College' },
      { name: 'Test Applicant' },
    );
    const cv = bdjobsToCvProfile(data!, now);
    expect(cv.education[0].institute).toBe('Example College');
    expect(cv.education[0].degree).toBeUndefined();
  });

  it('survives Bdjobs sending the wrong type for a history', () => {
    // Nothing validates inside `profile` any more, so a string where an array
    // belongs must not become a 500.
    const data = bdjobsProfileToCandidateData(
      {
        currentEmployer: 'Alpha Ltd',
        employmentHistory: 'not an array',
        educationHistory: [null, 'x', { institute: 'Example College' }],
      },
      { name: 'Test Applicant' },
    );
    expect(() => bdjobsToCvProfile(data!, now)).not.toThrow();
    const cv = bdjobsToCvProfile(data!, now);
    expect(cv.education).toHaveLength(1);
    expect(cv.employment[0].company).toBe('Alpha Ltd');
  });
});
