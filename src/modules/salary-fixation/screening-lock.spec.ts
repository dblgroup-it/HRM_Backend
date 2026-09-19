import { lockedMarkConflicts, lockedMarkMessage } from './screening-lock';

const state = (written: number | null, computer: number | null = null) => ({
  writtenTestObtained: written,
  computerTestObtained: computer,
});

describe('lockedMarkConflicts', () => {
  it('lets the first mark through', () => {
    expect(
      lockedMarkConflicts(state(null), {
        writtenTestTotal: 100,
        writtenTestObtained: 72,
      }),
    ).toEqual([]);
  });

  it('lets a mark through when no record exists yet', () => {
    expect(lockedMarkConflicts(null, { writtenTestObtained: 72 })).toEqual([]);
  });

  it('refuses a second, different mark', () => {
    expect(lockedMarkConflicts(state(72), { writtenTestObtained: 80 })).toEqual(
      ['Written Test'],
    );
  });

  it('refuses a change to the total once the mark is in', () => {
    // Moving the denominator changes the percentage just as surely.
    expect(lockedMarkConflicts(state(72), { writtenTestTotal: 50 })).toEqual([
      'Written Test',
    ]);
  });

  it('allows re-sending the same mark', () => {
    // The dialog saves both fields together; that must not read as an edit.
    expect(lockedMarkConflicts(state(72), { writtenTestObtained: 72 })).toEqual(
      [],
    );
  });

  it('locks each test on its own', () => {
    expect(
      lockedMarkConflicts(state(72, null), {
        writtenTestObtained: 80,
        computerTestObtained: 40,
      }),
    ).toEqual(['Written Test']);
  });

  it('names both when both are locked', () => {
    expect(
      lockedMarkConflicts(state(72, 40), {
        writtenTestObtained: 80,
        computerTestObtained: 45,
      }),
    ).toEqual(['Written Test', 'Computer Literacy']);
  });

  it('ignores fields the patch does not mention', () => {
    expect(
      lockedMarkConflicts(state(72), { computerTestObtained: 40 }),
    ).toEqual([]);
  });
});

describe('lockedMarkMessage', () => {
  it('agrees in number, and says who can fix it', () => {
    expect(lockedMarkMessage(['Written Test'])).toContain('mark has already');
    expect(lockedMarkMessage(['Written Test'])).toContain('Corporate HR');
    expect(lockedMarkMessage(['Written Test', 'Computer Literacy'])).toContain(
      'marks have already',
    );
  });
});
