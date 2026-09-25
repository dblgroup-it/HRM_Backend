import {
  applicationsCloseAt,
  applicationsOpen,
  lastDayToApply,
} from './application-window';

describe('applicationsOpen', () => {
  const posting = { closingDate: '2026-09-24' };

  it('is open all through the closing day in Dhaka', () => {
    // 23:59 Dhaka on the 24th is 17:59Z.
    expect(applicationsOpen(posting, new Date('2026-09-24T17:59:00Z'))).toBe(
      true,
    );
    // Early morning Dhaka on the 24th is still the 23rd in UTC.
    expect(applicationsOpen(posting, new Date('2026-09-23T19:00:00Z'))).toBe(
      true,
    );
  });

  it('closes at midnight after the closing day', () => {
    expect(applicationsCloseAt(posting)?.toISOString()).toBe(
      '2026-09-24T18:00:00.000Z',
    );
    expect(applicationsOpen(posting, new Date('2026-09-24T18:00:00Z'))).toBe(
      false,
    );
    expect(applicationsOpen(posting, new Date('2026-10-01T00:00:00Z'))).toBe(
      false,
    );
  });

  it('stays open when no usable closing date was set', () => {
    expect(applicationsOpen(null)).toBe(true);
    expect(applicationsOpen({})).toBe(true);
    expect(applicationsOpen({ closingDate: 'not a date' })).toBe(true);
  });
});

describe('lastDayToApply', () => {
  it('names the closing day itself, not the midnight after it', () => {
    expect(lastDayToApply({ closingDate: '2026-09-24' })).toBe('24 Sep 2026');
    expect(lastDayToApply({})).toBeNull();
  });
});
