import {
  dueReferralsWhere,
  openReferralWhere,
  REFERRAL_GIVE_UP_MS,
  REFERRAL_JOIN_MS,
  REFERRAL_QUIET_MS,
} from './referral-window';

const now = new Date('2026-10-05T10:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('referral window', () => {
  it('never sends a referral somebody can still add to', () => {
    // A referral is joinable while its last CV is younger than JOIN, and due
    // once it is older than QUIET — the two can never overlap.
    expect(REFERRAL_JOIN_MS).toBeLessThan(REFERRAL_QUIET_MS);
  });

  it('joins the same sender’s open referral for the same job and referrer', () => {
    expect(
      openReferralWhere({
        requisitionId: 'req-1',
        referrerCode: '15104846',
        createdById: 'u-1',
        now,
      }),
    ).toEqual({
      requisitionId: 'req-1',
      referrerCode: '15104846',
      createdById: 'u-1',
      notifiedAt: null,
      candidates: { some: { createdAt: { gt: minutesAgo(4) } } },
    });
  });

  it('is due once nothing has been added for five minutes, for up to two days', () => {
    expect(dueReferralsWhere(now)).toEqual({
      notifiedAt: null,
      createdAt: { gt: new Date(now.getTime() - REFERRAL_GIVE_UP_MS) },
      candidates: { none: { createdAt: { gt: minutesAgo(5) } } },
    });
  });
});
