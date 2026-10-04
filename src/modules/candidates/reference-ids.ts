/**
 * The numbers people quote back to us: an application (APP-2026-00031), told
 * to the candidate when they apply, and an employee referral (REF-2026-0007),
 * told to the employee who referred.
 *
 * The number is the database's own sequence — assigned on insert, never
 * reused, and running on across years as requisition codes do (REQ-2026-015
 * is followed by REQ-2027-016). The year is the Dhaka calendar year the record
 * was made in. Every candidate row is one application, however it arrived, so
 * each has an application number.
 *
 * Decorator-free so specs can import it.
 */

/** Bangladesh has no daylight saving: UTC+6 all year. */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

function dhakaYear(at: Date): number {
  return new Date(at.getTime() + DHAKA_OFFSET_MS).getUTCFullYear();
}

export function applicationId(no: number, createdAt: Date): string {
  return `APP-${dhakaYear(createdAt)}-${String(no).padStart(5, '0')}`;
}

export function referralId(no: number, createdAt: Date): string {
  return `REF-${dhakaYear(createdAt)}-${String(no).padStart(4, '0')}`;
}

/**
 * The application number in a search box entry that is an application ID —
 * "APP-2026-00031", "app 2026 31", "APP-31" — or null for anything else, so
 * a candidate quoting their ID can be found by it.
 */
export function applicationNoFromSearch(term: string): number | null {
  const m = /^\s*APP[\s-]*(?:\d{4}[\s-]+)?0*(\d{1,9})\s*$/i.exec(term);
  if (!m) return null;
  const no = Number(m[1]);
  return Number.isSafeInteger(no) && no > 0 && no <= 2_147_483_647 ? no : null;
}
