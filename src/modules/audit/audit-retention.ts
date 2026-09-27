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

import { retentionCutoff } from '../../common/util/retention-cutoff';

export const AUDIT_RETENTION_DAYS = 30;

/**
 * The first instant that is kept. Every entry created before it is deleted.
 * The day-counting rule is shared with the notification cleanup.
 */
export function auditRetentionCutoff(
  now: Date,
  days: number = AUDIT_RETENTION_DAYS,
): Date {
  return retentionCutoff(now, days);
}
