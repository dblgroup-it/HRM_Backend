/**
 * A candidate's gender, as the small indicator on their row shows it.
 *
 * Read by the AI off an uploaded CV, or taken from what BDJobs sends. Only
 * two values are ever stored; anything else — "Other", a blank, a value the
 * model was unsure of — stays null and the row shows nothing, rather than a
 * guess presented as a fact.
 */
export type CandidateGender = 'male' | 'female';

export function normalizeGender(value: unknown): CandidateGender | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'male' || v === 'm' || v === 'man') return 'male';
  if (v === 'female' || v === 'f' || v === 'woman') return 'female';
  return null;
}
