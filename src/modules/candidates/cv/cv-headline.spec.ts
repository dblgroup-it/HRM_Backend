import { cvHeadline } from './cv-headline';

describe('cvHeadline', () => {
  it('picks the latest title, company and computed years', () => {
    expect(
      cvHeadline({
        summary: {
          lastDesignation: ' Senior Executive,  HR ',
          lastOrganization: 'Meghna Knit Composite',
          totalExperienceYears: 6.04,
          statedExperienceYears: 7,
          currentlyEmployed: true,
        },
      }),
    ).toEqual({
      title: 'Senior Executive, HR',
      company: 'Meghna Knit Composite',
      years: 6,
      current: true,
    });
  });

  it('falls back to the years the CV states when none could be computed', () => {
    expect(
      cvHeadline({ summary: { lastOrganization: 'Padma Apparels', statedExperienceYears: 4 } }),
    ).toEqual({ title: null, company: 'Padma Apparels', years: 4, current: false });
  });

  it('is null for a CV nobody has read, or one that says nothing', () => {
    expect(cvHeadline(null)).toBeNull();
    expect(cvHeadline({})).toBeNull();
    expect(cvHeadline({ summary: { currentlyEmployed: false, totalExperienceYears: 0 } })).toBeNull();
  });
});
