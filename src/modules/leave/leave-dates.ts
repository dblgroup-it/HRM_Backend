import { BadRequestException } from '@nestjs/common';

/**
 * The day maths behind "3 days" and "back on the 29th".
 *
 * Its own file because dates on a calendar day, rather than an instant, are
 * where this codebase has been bitten before (see `zing-date.ts`): a leave set
 * at 9am must not expire at 9am on the last day, and "3 days" has to mean the
 * three days the person actually says they are away.
 */

/** End of the given day, in the server's own zone — the office's day. */
export function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * When the absence ends.
 *
 * `days` counts from today INCLUSIVE — "3 days" is today, tomorrow and the day
 * after, so they are back on the fourth — and lands at the end of that day, so
 * leave set mid-morning doesn't lapse mid-morning. Neither field means "until
 * further notice", which is ended by hand.
 */
export function resolveLeaveEnd(
  input: { days?: number; until?: string },
  now = new Date(),
): Date | null {
  if (input.until) {
    const parsed = new Date(input.until);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('That return date could not be read');
    }
    return endOfDay(parsed);
  }
  if (input.days) {
    const end = new Date(now);
    end.setDate(end.getDate() + input.days - 1);
    return endOfDay(end);
  }
  return null;
}

/**
 * Whole days left, counting today — the number on the header button.
 *
 * Rounded up, so the last day of an absence reads "1 day left" all day rather
 * than counting down to zero while the person is still away.
 */
export function leaveDaysLeft(
  endsAt: Date | null,
  now = new Date(),
): number | null {
  if (!endsAt) return null;
  const ms = endsAt.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}
