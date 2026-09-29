/**
 * "Has this person applied to us before?" — by email or by mobile.
 *
 * It used to be email alone, which missed the commonest repeat applicant of
 * all: somebody who applies again from a new address with the same phone.
 * A mobile number is compared on its last ten digits, so +880 1712-345678,
 * 01712345678 and 8801712345678 are one number; anything shorter than ten
 * digits is too partial to match on and is ignored.
 *
 * Kept free of Prisma and Nest so the rule can be tested on its own, and so
 * the list count and the history modal cannot count differently.
 */

/** Lower-cased, trimmed email, or null when there is none. */
export function emailKey(email?: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/** The last ten digits of a phone number, or null when it has fewer. */
export function phoneKey(phone?: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export interface ApplicantIdentity {
  id: string;
  email?: string | null;
  phone?: string | null;
}

/**
 * The application rows that are the same person as `who`: same email or same
 * mobile. `who` itself is included when it is in `pool`, so a first-time
 * applicant counts 1.
 */
export function sameApplicant<T extends ApplicantIdentity>(
  who: ApplicantIdentity,
  pool: T[],
): T[] {
  const e = emailKey(who.email);
  const p = phoneKey(who.phone);
  if (!e && !p) return pool.filter((row) => row.id === who.id);
  return pool.filter(
    (row) =>
      row.id === who.id ||
      (e !== null && emailKey(row.email) === e) ||
      (p !== null && phoneKey(row.phone) === p),
  );
}

/** How many times each of `rows` has applied, counting itself. */
export function applyCounts(
  rows: ApplicantIdentity[],
  pool: ApplicantIdentity[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const matches = sameApplicant(row, pool);
    // The row itself is always an application, even if the pool query
    // missed it (a candidate with neither email nor phone is not fetched).
    const counted = matches.some((m) => m.id === row.id)
      ? matches.length
      : matches.length + 1;
    out.set(row.id, counted);
  }
  return out;
}
