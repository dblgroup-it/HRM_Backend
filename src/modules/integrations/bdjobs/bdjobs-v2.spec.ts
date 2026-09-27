import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { bdjobsToCvProfile } from '../../candidates/cv/bdjobs-cv.mapper';
import { buildCvDocument } from '../../candidates/cv/cv-document';
import { cvProfileToText } from '../../candidates/cv/cv-text';
import { BdJobsInboundCandidateDto } from './dto/bdjobs-inbound.dto';
import { BDJOBS_V2_EXAMPLE } from './bdjobs-v2.example';

const NOW = new Date('2026-09-27T06:00:00Z');

/** The inbound pipe's own settings — an undeclared key is a 400. */
async function pipeErrors(body: unknown) {
  const dto = plainToInstance(BdJobsInboundCandidateDto, body);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

/**
 * What the handler actually receives: the global pipe (with implicit
 * conversion, as main.ts sets it) and then the route's own pipe.
 */
async function throughPipes(body: unknown): Promise<BdJobsInboundCandidateDto> {
  const meta = { type: 'body' as const, metatype: BdJobsInboundCandidateDto };
  const global = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const route = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  return route.transform(await global.transform(body, meta), meta);
}

describe('BDJobs v2 payload (51 parameters)', () => {
  it('reaches the handler with every row intact', async () => {
    // Implicit conversion used to turn each row of these lists into [],
    // so every job and qualification sent here arrived empty.
    const dto = await throughPipes(JSON.parse(JSON.stringify(BDJOBS_V2_EXAMPLE)));
    expect(JSON.parse(JSON.stringify(dto.CandidateData))).toEqual(
      BDJOBS_V2_EXAMPLE.CandidateData,
    );
  });

  it('passes the inbound validation, every new section included', async () => {
    expect(await pipeErrors(BDJOBS_V2_EXAMPLE)).toEqual([]);
  });

  it('ignores extra keys inside a section but rejects an unknown section', async () => {
    // As section 4 of the document sent to BDJobs promises.
    const base = { bdJobsJobId: '1', applicationId: 'A', ts: 1 };
    expect(
      await pipeErrors({
        ...base,
        CandidateData: {
          personalData: { fullName: 'A', hobby: 'chess' },
          skills: [{ name: 'Excel', level: 'expert' }],
        },
      }),
    ).toEqual([]);
    const errors = await pipeErrors({
      ...base,
      CandidateData: { personalData: { fullName: 'A' }, trainigs: [] },
    });
    expect(JSON.stringify(errors)).toMatch(/trainigs/);
  });

  it('still accepts a v1 payload with none of the new sections', async () => {
    const v1 = {
      bdJobsJobId: '1',
      applicationId: 'A-1',
      ts: 1,
      CandidateData: {
        personalData: { fullName: 'Old Shape', emailId: 'o@example.com' },
        EmploymentHistory: [{ companyName: 'X', fromDate: '01/01/2020' }],
        qualifications: [{ institute: 'Y', passYear: 2015, grade: 'A' }],
      },
    };
    expect(await pipeErrors(v1)).toEqual([]);
    const cv = bdjobsToCvProfile(v1.CandidateData, NOW);
    expect(cv.personal.fullName).toBe('Old Shape');
    expect(cv.education[0].result).toBe('A');
    expect(cv.training).toBeUndefined();
    expect(cv.skills).toBeUndefined();
  });

  it('reads every section into the stored CV', () => {
    const warnings: string[] = [];
    const cv = bdjobsToCvProfile(BDJOBS_V2_EXAMPLE.CandidateData, NOW, warnings);
    expect(warnings).toEqual([]);

    expect(cv.personal).toMatchObject({
      fullName: 'Md. Rakibul Hasan',
      fatherName: 'Md. Abdul Hasan',
      motherName: 'Mst. Rokeya Begum',
      dateOfBirth: '1994-03-14',
      gender: 'Male',
      maritalStatus: 'Married',
      nationality: 'Bangladeshi',
      religion: 'Islam',
      bloodGroup: 'B+',
      heightMeters: 1.72,
      weightKg: 70,
    });
    expect(cv.contact).toMatchObject({
      email: 'rakibul.hasan@example.com',
      phone: '+880 1712345678',
      currentAddress: 'House 12, Road 5, Block C, Mirpur-10, Dhaka-1216',
      facebookUrl: 'https://www.facebook.com/rakibul.hasan',
      linkedinUrl: 'https://www.linkedin.com/in/rakibulhasan',
    });
    expect(cv.careerObjective).toMatch(/merchandising professional/);
    expect(cv.summary.statedExperienceYears).toBe(6.5);

    expect(cv.employment[0]).toMatchObject({
      company: 'Ha-Meem Group',
      location: 'Tejgaon, Dhaka',
      expertise: 'Knit merchandising, costing',
      role: expect.stringMatching(/European buyers/),
      current: true,
    });
    expect(cv.education[0]).toMatchObject({
      degree: 'MBA',
      major: 'Marketing',
      result: '3.62 out of 4',
      passYear: 2018,
      duration: '2 years',
      achievement: "Dean's list",
    });
    expect(cv.training?.[0]).toMatchObject({
      title: 'Advanced Garment Costing',
      year: 2022,
      country: 'Bangladesh',
    });
    expect(cv.certifications?.[0]).toMatchObject({
      name: 'Certified Merchandising Professional',
      from: '2023-01-01',
      to: '2023-06-30',
    });
    expect(cv.career).toEqual({
      preferredJobCategories: ['Garments/Textile', 'Merchandising'],
      jobLevel: 'Mid',
      preferredDistricts: ['Dhaka', 'Gazipur'],
      preferredOrganizationTypes: ['Garments', 'Textile'],
    });
    expect(cv.compensation).toEqual({ current: 55000, expected: 70000 });
    expect(cv.skills?.map((k) => k.name)).toEqual(['Merchandising', 'MS Excel']);
    expect(cv.languages?.[1]).toEqual({
      language: 'English',
      reading: 'High',
      writing: 'Medium',
      speaking: 'Medium',
    });
    expect(cv.references?.[0]).toMatchObject({
      name: 'Md. Kamal Uddin',
      relation: 'Professional',
      phone: '+880 1811000000',
    });
  });

  it('takes multi-select answers as a pipe- or comma-separated string too', () => {
    const cv = bdjobsToCvProfile(
      {
        personalData: { fullName: 'A' },
        careerInfo: { preferredDistricts: 'Dhaka | Gazipur,Narayanganj' },
      },
      NOW,
    );
    expect(cv.career?.preferredDistricts).toEqual(['Dhaka', 'Gazipur', 'Narayanganj']);
  });

  it('reports what it could not read instead of failing', () => {
    const warnings: string[] = [];
    bdjobsToCvProfile(
      {
        personalData: { fullName: 'A', linkedinUrl: 'not a url at all' },
        trainings: [{ institute: 'No title' }],
        professionalQualifications: [{ certification: 'C', fromDate: '2023/13/01' }],
        references: [{ organization: 'Nobody' }],
      },
      NOW,
      warnings,
    );
    expect(warnings.join('\n')).toMatch(/linkedinUrl/);
    expect(warnings.join('\n')).toMatch(/trainings\[0\] has no title/);
    expect(warnings.join('\n')).toMatch(/professionalQualifications\[0\]\.fromDate/);
    expect(warnings.join('\n')).toMatch(/references\[0\] has no name/);
  });

  it('prints the new sections in the generated CV, with the photo', () => {
    const cv = bdjobsToCvProfile(BDJOBS_V2_EXAMPLE.CandidateData, NOW);
    const html = buildCvDocument(cv, NOW, 'data:image/png;base64,iVBORw0KGgo=');
    for (const heading of [
      'Career Objective',
      'Training',
      'Professional Certifications',
      'Career and Application',
      'Skills',
      'Languages',
      'References',
    ])
      expect(html).toContain(heading);
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).toContain("Mother's name");
  });

  it('never embeds a photo that is not inline image data', () => {
    const cv = bdjobsToCvProfile(BDJOBS_V2_EXAMPLE.CandidateData, NOW);
    expect(buildCvDocument(cv, NOW, 'https://evil.example/x.png')).not.toContain('evil.example');
  });

  it('gives the AI screen the new sections but not the referees', () => {
    const text = cvProfileToText(bdjobsToCvProfile(BDJOBS_V2_EXAMPLE.CandidateData, NOW));
    expect(text).toMatch(/TRAINING/);
    expect(text).toMatch(/PROFESSIONAL CERTIFICATIONS/);
    expect(text).toMatch(/LANGUAGES/);
    expect(text).not.toMatch(/Kamal Uddin/);
  });
});
