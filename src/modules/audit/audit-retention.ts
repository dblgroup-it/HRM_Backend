/**
 * How long the system activity log is kept.
 *
 * Thirty calendar days, counted in Dhaka time and including today: on
 * 27 September everything from 29 August 00:00 onward stays (29 Aug to
 * 27 Sep is 30 days), and 28 August and earlier goes. Whole days rather than "now minus 30 × 24 hours", so what
 * is kept does not depend on the hour the job happened to run, and the page
 * can say plainly which date the log starts from.
 *
 * Decorator-free so the spec can import it.
 */

export const AUDIT_RETENTION_DAYS = 30;

/** Bangladesh has no daylight saving: UTC+6 all year. */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first instant that is kept. Every entry created before it is deleted.
 */
export function auditRetentionCutoff(
  now: Date,
  days: number = AUDIT_RETENTION_DAYS,
): Date {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError('days must be a whole number of at least 1');
  }
  // Shift into Dhaka wall-clock time, drop to that day's midnight, step back
  // (days − 1) days so today counts as the first of them, and shift back.
  const local = now.getTime() + DHAKA_OFFSET_MS;
  const localMidnight = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
  return new Date(localMidnight - (days - 1) * DAY_MS - DHAKA_OFFSET_MS);
}
