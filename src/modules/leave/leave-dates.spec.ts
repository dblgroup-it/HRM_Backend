import { BadRequestException } from '@nestjs/common';

import { leaveDaysLeft, resolveLeaveEnd } from './leave-dates';

/**
 * "3 days" has to mean the three days somebody says they are away, and leave
 * set at 9am must not lapse at 9am on the last day — the kind of off-by-a-day
 * that only shows up as a requisition quietly landing back on the wrong desk.
 */
describe('leave dates', () => {
  // Mid-morning, deliberately: the bug this pins is the time of day leaking in.
  const now = new Date('2026-09-22T09:30:00');

  it('counts the quick-pick days from today, inclusive', () => {
    const end = resolveLeaveEnd({ days: 3 }, now);
    // Away today, the 23rd and the 24th — back on the 25th.
    expect(end?.getFullYear()).toBe(2026);
    expect(end?.getMonth()).toBe(8); // September
    expect(end?.getDate()).toBe(24);
  });

  it('ends at the end of the last day, not at the hour it was set', () => {
    const end = resolveLeaveEnd({ days: 1 }, now);
    expect(end?.getDate()).toBe(22);
    expect(end?.getHours()).toBe(23);
    expect(end?.getMinutes()).toBe(59);
  });

  it('treats a chosen return date as the last day away', () => {
    const end = resolveLeaveEnd({ until: '2026-10-05' }, now);
    expect(end?.getDate()).toBe(5);
    expect(end?.getMonth()).toBe(9); // October
    expect(end?.getHours()).toBe(23);
  });

  it('means "until further notice" when neither is given', () => {
    expect(resolveLeaveEnd({}, now)).toBeNull();
  });

  it('refuses a date it cannot read', () => {
    expect(() => resolveLeaveEnd({ until: 'next Tuesday' }, now)).toThrow(
      BadRequestException,
    );
  });

  it('still reads as a day left on the last day', () => {
    const end = resolveLeaveEnd({ days: 3 }, now);
    // Late on the final evening, the person is still away.
    const lastEvening = new Date('2026-09-24T22:00:00');
    expect(leaveDaysLeft(end, lastEvening)).toBe(1);
    expect(leaveDaysLeft(end, now)).toBe(3);
  });

  it('reads as none left once the period is over', () => {
    const end = resolveLeaveEnd({ days: 1 }, now);
    expect(leaveDaysLeft(end, new Date('2026-09-23T08:00:00'))).toBe(0);
  });

  it('has no countdown for an open-ended absence', () => {
    expect(leaveDaysLeft(null, now)).toBeNull();
  });
});
