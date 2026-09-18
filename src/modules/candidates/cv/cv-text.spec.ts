import { bdjobsToCvProfile } from './bdjobs-cv.mapper';
import { cvProfileToText } from './cv-text';
import type { CvProfile } from './cv-profile.types';

const NOW = new Date('2026-09-14T00:00:00.000Z');

/**
 * Structurally as Bdjobs sends it, with invented values — real applicant
 * details do not belong in a repository.
 */
const NESTED = {
  personalData: {
    salutation: 'Mr.',
    fullName: 'Test Applicant',
    requisitionId: 'REQ-2026-001',
    countryCode: '+880',
    mobileNo: '01800000000',
    emailId: 'test.applicant@example.invalid',
    gender: 'Male',
    currentAddress1: '1 Example Road, Dhaka',
    expectedSalary: 55000,
    MaritalStatus: 'Unmarried',
  },
  EmploymentHistory: [
    {
      companyName: 'Example Ltd',
      designation: 'Analyst',
      role: 'Merchandising and buyer communication',
      fromDate: '01/12/2018',
      toDate: '14/09/2026',
    },
  ],
  qualifications: [
    {
      university: 'Example University',
      institute: 'Example University',
      country: 'Bangladesh',
      passYear: 2013,
      percentage: '45%',
    },
  ],
};

describe('cvProfileToText', () => {
  const body = cvProfileToText(bdjobsToCvProfile(NESTED, NOW));

  it('states who the candidate is and how to reach them', () => {
    expect(body).toContain('Name: Mr. Test Applicant');
    expect(body).toContain('Email: test.applicant@example.invalid');
    expect(body).toContain('Phone: +880 01800000000');
    expect(body).toContain('Current address: 1 Example Road, Dhaka');
  });

  it('gives the screener the derived facts it scores against', () => {
    expect(body).toContain('Total experience:');
    expect(body).toContain('Currently at: Example Ltd — Analyst');
    expect(body).toContain('Expected salary: 55000 per month');
  });

  it('lists employment with a readable period and the role text', () => {
    expect(body).toContain('EMPLOYMENT HISTORY');
    expect(body).toContain('1. Analyst at Example Ltd (Dec 2018 – Present)');
    expect(body).toContain('Merchandising and buyer communication');
  });

  it('lists education with institute, year and result', () => {
    expect(body).toContain('EDUCATION');
    expect(body).toContain('Example University');
    expect(body).toContain('passed 2013');
    expect(body).toContain('result 45%');
  });

  it('omits fields the application never sent rather than printing blanks', () => {
    expect(body).not.toContain('Blood group');
    expect(body).not.toMatch(/: *$/m);
  });

  it('says so explicitly when a section is empty, so the score is not a guess', () => {
    const bare: CvProfile = {
      source: 'bdjobs',
      capturedAt: NOW.toISOString(),
      personal: { fullName: 'No History' },
      contact: {},
      employment: [],
      education: [],
      compensation: {},
      summary: { currentlyEmployed: false },
    };
    const out = cvProfileToText(bare);
    expect(out).toContain(
      'EMPLOYMENT HISTORY\nNone stated in the application.',
    );
    expect(out).toContain('EDUCATION\nNone stated in the application.');
  });

  it('survives a profile whose arrays are missing entirely', () => {
    // Older rows were written before some of these keys existed; the screener
    // must not be the thing that throws.
    const legacy = {
      source: 'bdjobs',
      capturedAt: NOW.toISOString(),
      personal: { fullName: 'Legacy Row' },
    } as unknown as CvProfile;
    expect(() => cvProfileToText(legacy)).not.toThrow();
    expect(cvProfileToText(legacy)).toContain('Name: Legacy Row');
  });
});
