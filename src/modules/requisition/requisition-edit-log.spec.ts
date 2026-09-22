import { describeRequisitionEdit } from './requisition.service';

/**
 * What an edit writes into the activity log.
 *
 * The requisition can now be corrected by the HR side at any point in its
 * life — including after it was signed — so the log is the only record of
 * what a signed document used to say. Two ways it can fail: recording changes
 * that did not happen (the log fills with noise and stops being read), and
 * failing to record ones that did.
 */
const before = {
  grade: 'M1',
  requiredPosts: 2,
  totalVacantPosts: 3,
  placeOfPosting: 'Kashimpur',
  vacantDate: new Date('2026-03-01T00:00:00.000Z'),
  neededDate: null,
  priority: 'MODERATE',
  employmentNature: 'PERMANENT',
  contractualPurpose: null,
  jobDescription: 'Runs the knitting floor.',
  education: 'B.Sc. in Textile Engineering',
  experience: '3–5 years',
  others: null,
};

describe('describeRequisitionEdit', () => {
  it('records nothing when the form comes back unchanged', () => {
    expect(
      describeRequisitionEdit(
        before,
        {
          requiredPosts: 2,
          placeOfPosting: 'Kashimpur',
          priority: 'moderate',
          employmentNature: 'permanent',
          jobDescription: 'Runs the knitting floor.',
          vacantDate: '2026-03-01',
        },
        'M1',
      ),
    ).toEqual([]);
  });

  it('names the field and both values for a short field', () => {
    expect(
      describeRequisitionEdit(before, { requiredPosts: 4 }, undefined),
    ).toEqual(['Required posts: 2 → 4']);
    expect(describeRequisitionEdit(before, {}, 'M2')).toEqual([
      'Job Grade: M1 → M2',
    ]);
    // Cleared, not blank: "—" reads as an answer where "" reads as a bug.
    expect(describeRequisitionEdit(before, {}, null)).toEqual([
      'Job Grade: M1 → —',
    ]);
  });

  it('compares dates by the day, not by the string', () => {
    expect(
      describeRequisitionEdit(before, { vacantDate: '2026-04-15' }, undefined),
    ).toEqual(['Vacant date: 2026-03-01 → 2026-04-15']);
    // The same day sent as a full timestamp is not an edit.
    expect(
      describeRequisitionEdit(
        before,
        { vacantDate: '2026-03-01T00:00:00.000Z' },
        undefined,
      ),
    ).toEqual([]);
  });

  it('says what happened to prose rather than pasting it', () => {
    expect(
      describeRequisitionEdit(
        before,
        { jobDescription: 'Runs the knitting floor and the dye house.' },
        undefined,
      ),
    ).toEqual(['Job description rewritten (was 24 characters)']);
    expect(
      describeRequisitionEdit(before, { others: 'Shift work' }, undefined),
    ).toEqual(['Others added']);
    expect(
      describeRequisitionEdit(before, { education: '  ' }, undefined),
    ).toEqual(['Education & training cleared']);
  });

  it('collects every change in one entry', () => {
    const out = describeRequisitionEdit(
      before,
      {
        requiredPosts: 3,
        priority: 'top',
        placeOfPosting: 'Mawna',
        experience: '5–7 years',
      },
      'M2',
    );
    expect(out).toEqual([
      'Job Grade: M1 → M2',
      'Required posts: 2 → 3',
      'Place of posting: Kashimpur → Mawna',
      'Priority: moderate → top',
      'Experience rewritten (was 9 characters)',
    ]);
  });
});
