import { profileCvLink, ttlUntil } from './profile-cv-link';

/**
 * One CV per candidate, the personal one first (owner's decision,
 * 2026-10-14): the BDJobs CV is offered only when the candidate has no CV of
 * their own. The source still travels, so the one button can say which it is.
 */

const files = { mint: jest.fn(() => 'GRANT') };
const BDJOBS = { source: 'bdjobs' };

describe('profileCvLink', () => {
  beforeEach(() => files.mint.mockClear());

  it('offers the BDJobs CV when the applicant attached no CV', () => {
    const link = profileCvLink(files, {
      id: 'c1',
      name: 'A',
      cvProfile: BDJOBS,
    });
    expect(link).toEqual({
      profileCvUrl: '/api/candidates/profile-cv/GRANT',
      profileCvSource: 'bdjobs',
    });
    expect(files.mint).toHaveBeenCalledWith('c1', 'cv-profile', {
      filename: 'A — CV',
      ttlSeconds: undefined,
    });
  });

  it('makes no BDJobs CV link when there is a personal CV — that is the one shown', () => {
    for (const personal of [
      { cvUrl: 'https://bdjobs.example/cv.pdf' },
      { cvFileId: 'drive-1' },
    ]) {
      const link = profileCvLink(files, {
        id: 'c1',
        name: 'A',
        cvProfile: BDJOBS,
        ...personal,
      });
      // Still says it is a BDJobs applicant, so the button reads "Personal CV".
      expect(link).toEqual({ profileCvUrl: null, profileCvSource: 'bdjobs' });
    }
    expect(files.mint).not.toHaveBeenCalled();
  });

  it('offers it beside the personal CV for the pipeline row only, and only for BDJobs', () => {
    const both = profileCvLink(
      files,
      { id: 'c1', name: 'A', cvProfile: BDJOBS, cvUrl: 'https://x/cv.pdf' },
      { alongsidePersonal: true },
    );
    expect(both.profileCvUrl).toBe('/api/candidates/profile-cv/GRANT');
    const upload = profileCvLink(
      files,
      { id: 'c2', name: 'B', cvProfile: { source: 'upload' }, cvFileId: 'd' },
      { alongsidePersonal: true },
    );
    expect(upload.profileCvUrl).toBeNull();
  });

  it('has nothing to offer without a stored profile', () => {
    expect(profileCvLink(files, { id: 'c1', name: 'A' })).toEqual({
      profileCvUrl: null,
      profileCvSource: null,
    });
  });

  it('never offers an upload’s own reading of itself', () => {
    const link = profileCvLink(files, {
      id: 'c1',
      name: 'A',
      cvProfile: { source: 'upload' },
      cvFileId: 'drive-1',
    });
    expect(link.profileCvUrl).toBeNull();
  });
});

describe('ttlUntil', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  it('lasts as long as the access it rides on, within 15 minutes and 30 days', () => {
    expect(ttlUntil(new Date(now + 3_600_000), now)).toBe(3600);
    expect(ttlUntil(new Date(now - 1000), now)).toBe(15 * 60);
    expect(ttlUntil(new Date(now + 90 * 86_400_000), now)).toBe(30 * 86_400);
    expect(ttlUntil(null, now)).toBe(15 * 60);
  });
});
