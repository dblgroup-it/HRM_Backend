/**
 * An approximate age when the CV gives no date of birth.
 *
 * In Bangladesh the SSC is sat at about 16 and the HSC at about 18, so the
 * pass year puts the birth year within a year or so. DBL's rule (owner's
 * decision, 2026-09-27): everybody is taken as 16 at SSC and 18 at HSC. SSC is
 * preferred when both are present — fewer people repeat a year before it.
 *
 * Only ever an estimate, and always shown as one: an interviewer who reads
 * "≈ 28" knows to ask, where a bare "28" would be taken as fact.
 *
 * Decorator-free so the spec can import it.
 */

export interface AgeEstimate {
  age: number;
  basis: 'SSC' | 'HSC';
  /** The pass year the estimate was taken from. */
  year: number;
}

const AGE_AT = { SSC: 16, HSC: 18 } as const;

// Dotted, spaced or plain: "SSC", "S.S.C.", "S S C". Checked for HSC first,
// because "Higher Secondary School Certificate" contains the SSC wording.
const HSC = /\b(h\.?\s?s\.?\s?c\.?|higher secondary|alim|a[\s-]?levels?)(?![a-z])/i;
const SSC = /\b(s\.?\s?s\.?\s?c\.?|secondary school certificate|dakhil|o[\s-]?levels?)(?![a-z])/i;

export function levelOf(degree: string | null | undefined): 'SSC' | 'HSC' | null {
  const d = (degree ?? '').trim();
  if (!d) return null;
  if (HSC.test(d)) return 'HSC';
  if (SSC.test(d)) return 'SSC';
  return null;
}

export function estimateAge(
  education: { degree?: string | null; passYear?: number | null }[],
  now: Date = new Date(),
): AgeEstimate | null {
  const thisYear = now.getFullYear();
  const found: Partial<Record<'SSC' | 'HSC', number>> = {};
  for (const e of education) {
    const level = levelOf(e.degree);
    const year = Number(e.passYear);
    if (!level || !Number.isInteger(year) || year < 1950 || year > thisYear) continue;
    // Earliest sitting, if a level appears twice (a retake).
    found[level] = Math.min(found[level] ?? year, year);
  }
  for (const basis of ['SSC', 'HSC'] as const) {
    const year = found[basis];
    if (year === undefined) continue;
    const age = thisYear - (year - AGE_AT[basis]);
    if (age >= 14 && age <= 80) return { age, basis, year };
  }
  return null;
}
