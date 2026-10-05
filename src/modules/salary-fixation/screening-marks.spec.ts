import { screeningMarkProblem } from './screening-marks';

const none = {
  writtenTestTotal: null,
  writtenTestObtained: null,
  computerTestTotal: null,
  computerTestObtained: null,
};

describe('screeningMarkProblem', () => {
  it('refuses a mark above its total — the row the database turned into a 500', () => {
    // 05 Oct: Written 57 / 100 was fine, Computer Literacy 68 / 50 was not.
    expect(
      screeningMarkProblem({
        writtenTestTotal: 100,
        writtenTestObtained: 57,
        computerTestTotal: 50,
        computerTestObtained: 68,
      }),
    ).toBe(
      'Computer Literacy: 68 obtained is more than the total of 50. Correct the marks and save again.',
    );
  });

  it('accepts a full mark, and marks within their totals', () => {
    expect(
      screeningMarkProblem({
        writtenTestTotal: 100,
        writtenTestObtained: 100,
        computerTestTotal: 50,
        computerTestObtained: 0,
        aiTestTotal: 20,
        aiTestObtained: 12.5,
      }),
    ).toBeNull();
  });

  it('lets either half arrive first', () => {
    expect(
      screeningMarkProblem({ ...none, writtenTestObtained: 68 }),
    ).toBeNull();
    expect(screeningMarkProblem({ ...none, writtenTestTotal: 50 })).toBeNull();
    expect(screeningMarkProblem(none)).toBeNull();
  });

  it('refuses a total of 0 or less, and a negative mark', () => {
    expect(screeningMarkProblem({ ...none, writtenTestTotal: 0 })).toBe(
      'Written Test: the total must be more than 0.',
    );
    expect(screeningMarkProblem({ ...none, computerTestObtained: -1 })).toBe(
      'Computer Literacy: the mark obtained cannot be below 0.',
    );
  });

  it('checks the AI test too', () => {
    expect(
      screeningMarkProblem({ ...none, aiTestTotal: 20, aiTestObtained: 21 }),
    ).toBe(
      'AI Proficiency: 21 obtained is more than the total of 20. Correct the marks and save again.',
    );
  });

  it('writes fractions short', () => {
    expect(
      screeningMarkProblem({
        ...none,
        writtenTestTotal: 10,
        writtenTestObtained: 10.000000001 + 0.5,
      }),
    ).toBe(
      'Written Test: 10.5 obtained is more than the total of 10. Correct the marks and save again.',
    );
  });
});
