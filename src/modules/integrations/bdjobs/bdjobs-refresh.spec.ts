import type { CvProfile } from '../../candidates/cv/cv-profile.types';
import { refreshUpdate, samePayload, storablePayload } from './bdjobs-refresh';

/**
 * A resend of an application we have: BDJobs' data is refreshed, HR's work
 * is not touched, a retry of the same payload changes nothing, and what is
 * kept of the payload is small and reusable.
 */

const NOW = new Date('2026-10-13T12:00:00Z');

const CV = {
  source: 'bdjobs',
  compensation: { expected: 60000 },
  personal: { fullName: 'Mr Example' },
} as unknown as CvProfile;

const EXISTING = {
  email: 'corrected.by.hr@example.invalid',
  phone: null,
  gender: null,
  salaryExpectation: null,
  bdjobsApplicantId: null,
  cvFileId: null,
};

describe('storablePayload', () => {
  it('keeps what BDJobs sent, less the signature timestamp', () => {
    const kept = storablePayload({
      applicationId: 'A1',
      ts: 1791900000,
      profile: { fatherName: 'F' },
    });
    expect(kept).toEqual({ applicationId: 'A1', profile: { fatherName: 'F' } });
  });

  it('does not keep inline image bytes twice — the photo has its own table', () => {
    const kept = storablePayload({
      photo: { url: 'data:image/jpeg;base64,/9j/AAAA' },
      profile: { photo: { url: 'data:image/png;base64,iVBOR', fileName: 'p' } },
    });
    expect(JSON.stringify(kept)).not.toContain('base64');
    expect(
      (kept.profile as { photo: { fileName: string } }).photo.fileName,
    ).toBe('p');
  });

  it('keeps a photo link as it is', () => {
    const url = 'https://storage.example/photo.jpg';
    expect(storablePayload({ profile: { photo: { url } } })).toEqual({
      profile: { photo: { url } },
    });
  });
});

describe('samePayload', () => {
  it('treats a retry as the same payload, however the keys were ordered', () => {
    const stored = storablePayload({
      a: 1,
      profile: { x: [1, 2], y: 'b' },
      ts: 1,
    });
    const retry = storablePayload({
      profile: { y: 'b', x: [1, 2] },
      a: 1,
      ts: 2,
    });
    expect(samePayload(stored, retry)).toBe(true);
  });

  it('sees a real change, and treats a candidate with no stored copy as changed', () => {
    expect(samePayload({ a: 1 }, { a: 2 })).toBe(false);
    expect(samePayload(null, { a: 1 })).toBe(false);
    expect(samePayload(undefined, { a: 1 })).toBe(false);
  });
});

describe('refreshUpdate', () => {
  const resent = {
    cv: CV,
    email: 'from.bdjobs@example.invalid',
    phone: '+8801700000000',
    gender: 'male',
    resumeUrl: 'https://bdjobs.example/cv.pdf',
    applicantId: '8388729',
  };

  it("replaces BDJobs' data and fills only what is still blank", () => {
    const data = refreshUpdate(EXISTING, resent, NOW);
    expect(data.cvProfile).toBe(CV);
    expect(data.cvProfileAt).toBe(NOW);
    expect(data.cvUrl).toBe('https://bdjobs.example/cv.pdf');
    expect(data.phone).toBe('+8801700000000');
    expect(data.gender).toBe('male');
    expect(data.salaryExpectation).toBe(60000);
    expect(data.bdjobsApplicantId).toBe('8388729');
    // HR corrected the email; BDJobs does not get to undo that.
    expect(data).not.toHaveProperty('email');
  });

  it('never touches the stage, notes, name or anything else HR owns', () => {
    const data = refreshUpdate(EXISTING, resent, NOW);
    expect(Object.keys(data).sort()).toEqual(
      [
        'bdjobsApplicantId',
        'cvProfile',
        'cvProfileAt',
        'cvUrl',
        'gender',
        'phone',
        'salaryExpectation',
      ].sort(),
    );
  });

  it('leaves the CV link alone once HR has uploaded a file', () => {
    const data = refreshUpdate(
      { ...EXISTING, cvFileId: 'drive-1' },
      resent,
      NOW,
    );
    expect(data).not.toHaveProperty('cvUrl');
  });

  it('keeps the stored CV when the resend carries none', () => {
    const data = refreshUpdate(EXISTING, { ...resent, cv: null }, NOW);
    expect(data).not.toHaveProperty('cvProfile');
  });
});
