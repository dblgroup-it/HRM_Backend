/**
 * The first instant a "keep the last N days" rule keeps.
 *
 * N calendar days counted in Dhaka time, today included: with 30 days, on
 * 27 September everything from 29 August 00:00 stays. Whole days rather than
 * "now minus N × 24 hours", so what survives does not depend on the hour a
 * nightly job happened to run. Shared by every retention job so they all
 * count days the same way.
 */

/** Bangladesh has no daylight saving: UTC+6 all year. */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionCutoff(now: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError('days must be a whole number of at least 1');
  }
  const local = now.getTime() + DHAKA_OFFSET_MS;
  const localMidnight = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
  return new Date(localMidnight - (days - 1) * DAY_MS - DHAKA_OFFSET_MS);
}

/** "2026-08-29" — the Dhaka calendar day a cutoff falls on, for log lines. */
export function cutoffDay(cutoff: Date): string {
  return new Date(cutoff.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}
