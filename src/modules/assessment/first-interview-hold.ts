import { CandidateStage } from '@prisma/client';

import { isDecided } from './delegation-progress';

/**
 * A candidate whose first interview is out with somebody else.
 *
 * Head of Talent Acquisition hands a shortlisted candidate to a factory
 * colleague to run their first interview. That colleague then arranges the
 * round, which advances the candidate to the Interview stage — and the
 * recruiter's own Interviews tab, which lists everyone at that stage,
 * promptly showed the round back to them with a full set of schedule, edit,
 * reschedule and reject controls.
 *
 * Two people were being invited to run the same interview, and only one of
 * them had been asked to. This is the rule that keeps the recruiter's hands
 * off it until the interviewer has finished: while a hand-off is open and
 * undecided, the round belongs to the delegate and the tab says so instead of
 * offering it.
 *
 * Deliberately not an authorization check. The recruiter still owns the
 * requisition and can take the work back by withdrawing the delegation, which
 * is a deliberate act with a record — unlike quietly rescheduling somebody
 * else's interview from a screen that looked like their own.
 */
export interface FirstInterviewHold {
  /** Whoever the first interview is currently with. */
  delegates: { id: string; name: string }[];
}

/** One open hand-off, as the candidate row carries it. */
export interface HoldDelegationRow {
  revokedAt: Date | null;
  delegatedTo: { id: string; name: string };
}

export function firstInterviewHold(input: {
  stage: CandidateStage;
  rejectedAt: Date | null;
  /**
   * Undefined where the query did not ask for delegations — the caller gets
   * no hold rather than a wrong one, the same way `rejectedBy` is only
   * present where it was included.
   */
  interviewDelegations?: HoldDelegationRow[] | null;
}): FirstInterviewHold | null {
  // Filtered here rather than trusted from the query: a caller who forgets
  // `where: { revokedAt: null }` would otherwise hold a candidate whose
  // hand-off was withdrawn, and withdrawing is precisely how you take it back.
  const open = (input.interviewDelegations ?? []).filter((d) => !d.revokedAt);
  if (open.length === 0) return null;

  // Decided is the release. Not "marks are in" — a delegate who has scored
  // the candidate still owes the verdict, and the round is still theirs
  // until they give it.
  if (isDecided({ candidateStage: input.stage, rejectedAt: input.rejectedAt })) {
    return null;
  }

  // The same candidate can be handed to two people; both hold it, and the
  // tab names both rather than picking one arbitrarily.
  const seen = new Set<string>();
  const delegates: { id: string; name: string }[] = [];
  for (const d of open) {
    if (seen.has(d.delegatedTo.id)) continue;
    seen.add(d.delegatedTo.id);
    delegates.push({ id: d.delegatedTo.id, name: d.delegatedTo.name });
  }
  return { delegates };
}
