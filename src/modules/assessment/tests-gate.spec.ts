import { listTests, unmarkedTests } from './tests-gate';

const none = {
  writtenTestEnabled: false,
  writtenTestObtained: null,
  computerTestEnabled: false,
  computerTestObtained: null,
  aiTestEnabled: false,
  aiTestObtained: null,
};

describe('unmarkedTests', () => {
  it('asks for nothing when no tests were assigned', () => {
    expect(unmarkedTests(null)).toEqual([]);
    expect(unmarkedTests(none)).toEqual([]);
  });

  it('names every assigned test that has no mark', () => {
    expect(
      unmarkedTests({
        ...none,
        writtenTestEnabled: true,
        computerTestEnabled: true,
        aiTestEnabled: true,
      }),
    ).toEqual(['Written', 'Computer literacy', 'AI proficiency']);
  });

  it('is satisfied by a mark — zero counts as a mark', () => {
    expect(
      unmarkedTests({
        ...none,
        writtenTestEnabled: true,
        writtenTestObtained: 0,
      }),
    ).toEqual([]);
  });

  it('is satisfied by skipping the test, even with no mark', () => {
    // Skip switches the test off for this candidate.
    expect(
      unmarkedTests({
        ...none,
        writtenTestEnabled: false,
        aiTestEnabled: true,
      }),
    ).toEqual(['AI proficiency']);
  });
});

describe('listTests', () => {
  it('reads as a sentence', () => {
    expect(listTests(['Written'])).toBe('Written');
    expect(listTests(['Written', 'AI proficiency'])).toBe(
      'Written and AI proficiency',
    );
    expect(listTests(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
