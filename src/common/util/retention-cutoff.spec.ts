import { cutoffDay, retentionCutoff } from './retention-cutoff';

describe('retentionCutoff', () => {
  it('keeps 60 calendar days, today included, in Dhaka time', () => {
    // 27 Sep 2026 03:20 in Dhaka. 60 days, today included, start on 30 Jul.
    const cutoff = retentionCutoff(new Date('2026-09-26T21:20:00Z'), 60);
    expect(cutoffDay(cutoff)).toBe('2026-07-30');
    expect(cutoff.toISOString()).toBe('2026-07-29T18:00:00.000Z');
  });

  it('matches the 30-day activity rule', () => {
    const cutoff = retentionCutoff(new Date('2026-09-26T21:00:00Z'), 30);
    expect(cutoffDay(cutoff)).toBe('2026-08-29');
  });
});
