/**
 * Whether a posted requisition is still taking applications.
 *
 * The closing date is the last day to apply: a bare calendar day
 * ("2026-09-24"), open to the end of that day in Bangladesh (UTC+6, no
 * daylight saving) and closed from midnight after it. Posted requisitions
 * used to stay on the career page, and keep accepting CVs, indefinitely —
 * nothing read the date. The requisition itself stays POSTED: the recruiter
 * still works the pipeline it collected.
 *
 * Decorator-free so a test can import it.
 */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** The instant applications close, or null when no usable date was set. */
export function applicationsCloseAt(posting: unknown): Date | null {
  const raw = (posting as { closingDate?: unknown } | null)?.closingDate;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (day) {
    // Midnight at the start of the next day, Dhaka time.
    const next = Date.UTC(+day[1], +day[2] - 1, +day[3] + 1);
    return new Date(next - DHAKA_OFFSET_MS);
  }
  // Anything else (an ISO timestamp from an older client) is taken as given.
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** Open unless a closing date is set and has passed. */
export function applicationsOpen(posting: unknown, now = new Date()): boolean {
  const closes = applicationsCloseAt(posting);
  return !closes || now.getTime() < closes.getTime();
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "24 Sep 2026" — the last day to apply, in Dhaka. Null without a date. */
export function lastDayToApply(posting: unknown): string | null {
  const closes = applicationsCloseAt(posting);
  if (!closes) return null;
  // The instant it closes is midnight after the last day, Dhaka time.
  const d = new Date(closes.getTime() - 1 + DHAKA_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
