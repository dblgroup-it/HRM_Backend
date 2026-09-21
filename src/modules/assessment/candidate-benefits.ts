/**
 * The benefits a candidate can say their current package includes, ticked on
 * the interviewer's Salary & benefits form.
 *
 * Stored as these keys, never the label, so the wording on screen can change
 * without rewriting anyone's record. The labels live with the frontend
 * (`assessment/components/benefits.ts`) — keep the two lists in step.
 */
export const CANDIDATE_BENEFITS = [
  'lunch_full',
  'lunch_partial',
  'transport_free',
  'transport_paid',
  'profit_share',
  'dormitory',
  'family_accommodation',
  'tax_paid',
] as const;

export type CandidateBenefit = (typeof CANDIDATE_BENEFITS)[number];

/** Pairs that cannot both describe one package. */
const EXCLUSIVE: [CandidateBenefit, CandidateBenefit, string][] = [
  ['lunch_full', 'lunch_partial', 'Lunch is either full or partial, not both.'],
  [
    'transport_free',
    'transport_paid',
    'Pick and drop is either free or paid for, not both.',
  ],
];

/** Why this set of ticks cannot be saved, or null when it can. */
export function benefitsConflict(keys: readonly string[]): string | null {
  const set = new Set(keys);
  const clash = EXCLUSIVE.find(([a, b]) => set.has(a) && set.has(b));
  return clash ? clash[2] : null;
}

/** Deduplicated, in catalogue order — so the stored array is stable. */
export function normaliseBenefits(keys: readonly string[]): CandidateBenefit[] {
  const set = new Set(keys);
  return CANDIDATE_BENEFITS.filter((k) => set.has(k));
}
