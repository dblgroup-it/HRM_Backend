import type { Prisma } from '@prisma/client';

/**
 * When an employee referral is still being added to, and when its letters go.
 *
 * Referred CVs are often sent in one at a time — pick the source, pick the
 * referrer, drop a CV, send, and again for the next. Each send used to be a
 * referral of its own, so the referrer was thanked once per candidate, each
 * letter naming one. Now a send joins the same person's open referral for the
 * same job and referrer, and the letters wait until it has been quiet for a
 * while: one letter to the referrer, listing everyone.
 *
 * JOIN is shorter than QUIET on purpose. A referral the sweep could pick up is
 * one nobody can join any more, so the letter can never go out while a
 * candidate is being added to it.
 *
 * Decorator-free so the spec can import it.
 */

/** A send joins a referral whose last candidate arrived within this. */
export const REFERRAL_JOIN_MS = 4 * 60_000;
/** A referral's letters go once nothing has been added to it for this long. */
export const REFERRAL_QUIET_MS = 5 * 60_000;
/** Past this, a referral nobody wrote to is left alone — thanks that late is worse than none. */
export const REFERRAL_GIVE_UP_MS = 2 * 24 * 60 * 60_000;

/** The open referral a new referred CV should join, if there is one. */
export function openReferralWhere(input: {
  requisitionId: string;
  referrerCode: string;
  createdById: string;
  now: Date;
}): Prisma.CandidateReferralWhereInput {
  return {
    requisitionId: input.requisitionId,
    referrerCode: input.referrerCode,
    createdById: input.createdById,
    notifiedAt: null,
    candidates: {
      some: {
        createdAt: { gt: new Date(input.now.getTime() - REFERRAL_JOIN_MS) },
      },
    },
  };
}

/** Referrals whose letters are due: quiet long enough, not too old. */
export function dueReferralsWhere(
  now: Date,
): Prisma.CandidateReferralWhereInput {
  return {
    notifiedAt: null,
    createdAt: { gt: new Date(now.getTime() - REFERRAL_GIVE_UP_MS) },
    candidates: {
      none: {
        createdAt: { gt: new Date(now.getTime() - REFERRAL_QUIET_MS) },
      },
    },
  };
}
