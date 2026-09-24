import { headDecisionNoteError, headScope } from './first-interview-approval';

describe('headDecisionNoteError', () => {
  it('lets an approval through without a note', () => {
    expect(headDecisionNoteError('approve', undefined)).toBeNull();
  });

  it('asks for a reason to return or reject', () => {
    expect(headDecisionNoteError('return', '')).toMatch(/Factory HR/);
    expect(headDecisionNoteError('reject', '  ')).toMatch(/reason/);
    expect(
      headDecisionNoteError('reject', 'Weak on line balancing'),
    ).toBeNull();
  });
});

describe('headScope', () => {
  const role = (unitId: string | null, unitName: string | null) => ({
    key: 'factory_hr_head',
    unitId,
    unitName,
  });

  it('opens every unit to a super user', () => {
    expect(headScope({ isSuperUser: true, roles: [] })).toEqual({
      all: true,
      unitNames: [],
    });
  });

  it('limits a unit-scoped Head to their own units', () => {
    expect(
      headScope({
        isSuperUser: false,
        roles: [
          role('u1', 'Jinnat Textile Mills Ltd.'),
          { key: 'factory_hr', unitId: 'u2', unitName: 'Other' },
        ],
      }),
    ).toEqual({ all: false, unitNames: ['Jinnat Textile Mills Ltd.'] });
  });

  it('gives nothing to someone who does not hold the role', () => {
    expect(
      headScope({
        isSuperUser: false,
        roles: [{ key: 'factory_hr', unitId: 'u2', unitName: 'Other' }],
      }),
    ).toEqual({ all: false, unitNames: [] });
  });
});
