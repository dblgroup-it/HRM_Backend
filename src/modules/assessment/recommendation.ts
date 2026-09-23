/**
 * The three things an interviewer can suggest happens next.
 *
 * Its own module, free of decorators, so it can be imported by anything —
 * including a test — without dragging in class-validator's metadata runtime.
 * The DTO imports the list to validate against it.
 *
 * Lowercase is the wire and UI vocabulary; the Prisma enum is UPPERCASE, the
 * same split the requisition serializer uses for status.
 */
export const EVALUATION_RECOMMENDATIONS = [
  'select',
  'reject',
  /** Not for this role, but worth keeping — how the Talent Bank fills up. */
  'talent_pool',
] as const;

export type EvaluationRecommendationKey =
  (typeof EVALUATION_RECOMMENDATIONS)[number];
