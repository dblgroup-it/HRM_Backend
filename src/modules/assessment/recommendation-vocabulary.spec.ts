import { EvaluationRecommendation } from '@prisma/client';

import { EVALUATION_RECOMMENDATIONS } from './recommendation';

/**
 * The same three verdicts, spelled two ways.
 *
 * Prisma enums are UPPERCASE and the frontend's vocabulary is lowercase, so
 * the service converts with `toUpperCase()` / `toLowerCase()`. That works
 * exactly as long as the two lists stay in step — and `TALENT_POOL` /
 * `talent_pool` is precisely the shape that rots quietly: add a fourth verdict
 * on one side and the conversion produces a value the database rejects at
 * runtime, on submission, after the interview.
 */
describe('recommendation vocabulary', () => {
  const prismaValues = Object.values(EvaluationRecommendation);

  it('offers exactly the three verdicts the database accepts', () => {
    expect([...EVALUATION_RECOMMENDATIONS].sort()).toEqual(
      prismaValues.map((v) => v.toLowerCase()).sort(),
    );
  });

  it('round-trips every key through the conversion the service performs', () => {
    for (const key of EVALUATION_RECOMMENDATIONS) {
      const stored = key.toUpperCase();
      expect(prismaValues).toContain(stored as EvaluationRecommendation);
      expect(stored.toLowerCase()).toBe(key);
    }
  });

  it('round-trips every database value back to a key the UI knows', () => {
    for (const value of prismaValues) {
      expect([...EVALUATION_RECOMMENDATIONS]).toContain(
        value.toLowerCase() as (typeof EVALUATION_RECOMMENDATIONS)[number],
      );
    }
  });

  it('still includes talent_pool — the reason there are three and not two', () => {
    // "No" and "not for this post" are different outcomes, and the second is
    // how the Talent Bank fills up.
    expect([...EVALUATION_RECOMMENDATIONS]).toContain('talent_pool');
    expect(prismaValues).toContain(EvaluationRecommendation.TALENT_POOL);
  });
});
