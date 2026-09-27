import { auditRetentionCutoff } from './audit-retention';

describe('auditRetentionCutoff', () => {
  it('keeps today and the 29 days before it, in Dhaka time', () => {
    // 27 Sep 2026, 03:00 in Dhaka = 26 Sep 21:00 UTC.
    const cutoff = auditRetentionCutoff(new Date('2026-09-26T21:00:00Z'));
    // 29 Aug .. 27 Sep is 30 days. 29 Aug 00:00 in Dhaka = 28 Aug 18:00 UTC.
    expect(cutoff.toISOString()).toBe('2026-08-28T18:00:00.000Z');
  });

  it('does not depend on the hour it runs', () => {
    const early = auditRetentionCutoff(new Date('2026-09-26T18:00:00Z')); // 00:00 Dhaka
    const late = auditRetentionCutoff(new Date('2026-09-27T17:59:59Z')); // 23:59 Dhaka
    expect(early.toISOString()).toBe(late.toISOString());
  });

  it('moves on at Dhaka midnight, not UTC midnight', () => {
    const before = auditRetentionCutoff(new Date('2026-09-27T17:59:59Z')); // 27 Sep 23:59 Dhaka
    const after = auditRetentionCutoff(new Date('2026-09-27T18:00:00Z')); // 28 Sep 00:00 Dhaka
    expect(after.getTime() - before.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('keeps just today with a one-day window', () => {
    expect(
      auditRetentionCutoff(new Date('2026-09-27T06:00:00Z'), 1).toISOString(),
    ).toBe('2026-09-26T18:00:00.000Z');
  });

  it('refuses a nonsense window', () => {
    expect(() => auditRetentionCutoff(new Date(), 0)).toThrow(RangeError);
    expect(() => auditRetentionCutoff(new Date(), 2.5)).toThrow(RangeError);
  });
});
