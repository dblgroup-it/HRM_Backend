import { CandidateStage, InterviewStatus } from '@prisma/client';

/**
 * Where a delegated candidate has actually got to.
 *
 * One vocabulary, shared by the interviewer's own board, the per-candidate
 * view and the workload roll-up — so "waiting" means the same thing to the
 * person who sent the work and the person doing it. Ordered: each state is
 * strictly further along than the one before.
 */
export const DELEGATION_STAGES = [
  'sent',
  'scheduled',
  'interviewed',
  'marked',
  'decided',
] as const;

export type DelegationStage = (typeof DELEGATION_STAGES)[number];

/**
 * Rounds that did not happen: called off by us, or the candidate never came.
 * Neither counts as arranged, and neither stops a fresh round being booked.
 */
export const NOT_LIVE: readonly InterviewStatus[] = ['CANCELLED', 'ABSENT'];

export const DELEGATION_STAGE_LABEL: Record<DelegationStage, string> = {
  sent: 'No action yet',
  scheduled: 'Interview scheduled',
  interviewed: 'Interviewed, marks pending',
  marked: 'Marks in',
  decided: 'Decided',
};

/** Everything needed to place one delegation on that scale. */
export interface ProgressInput {
  candidateStage: CandidateStage;
  rejectedAt: Date | null;
  rounds: {
    status: InterviewStatus;
    scheduledAt: Date | null;
    evaluationCount: number;
  }[];
}

export interface DelegationProgress {
  stage: DelegationStage;
  label: string;
  /** Set once nothing more is expected from the interviewer. */
  complete: boolean;
  /** The scheduled sitting, when there is one. */
  scheduledAt: string | null;
}

/**
 * Derive the stage from what exists, rather than storing it.
 *
 * A stored status would need updating from six places (schedule, reschedule,
 * cancel, evaluate, reject, advance) and would be wrong the first time one of
 * them was missed. The underlying records already say what happened.
 */
export function delegationProgress(
  input: ProgressInput,
  now: Date = new Date(),
): DelegationProgress {
  const done = (stage: DelegationStage, scheduledAt: Date | null = null) => ({
    stage,
    label: DELEGATION_STAGE_LABEL[stage],
    complete: stage === 'decided' || stage === 'marked',
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
  });

  // A decision outranks everything: once the candidate is rejected or has moved
  // beyond the interview, nothing further is owed by the interviewer.
  if (input.rejectedAt) return done('decided');
  if (
    input.candidateStage === 'FINAL' ||
    input.candidateStage === 'SELECTED' ||
    input.candidateStage === 'REJECTED'
  ) {
    return done('decided');
  }

  // Cancelled and no-show rounds do not count as arranged — that is back to
  // square one. A no-show's slot has passed, so letting it through would read
  // as "interviewed, marks pending" for marks that are never coming.
  const live = input.rounds.filter((r) => !NOT_LIVE.includes(r.status));
  if (live.length === 0) return done('sent');

  if (live.some((r) => r.evaluationCount > 0)) {
    const marked = live.find((r) => r.evaluationCount > 0)!;
    return done('marked', marked.scheduledAt);
  }

  // "Has it happened yet" is the sitting time, not the status flag: a round
  // whose slot passed a week ago has been held whether or not anyone
  // remembered to mark it COMPLETED.
  const held = live.find(
    (r) =>
      r.status === 'COMPLETED' ||
      (r.scheduledAt !== null && r.scheduledAt <= now),
  );
  if (held) return done('interviewed', held.scheduledAt);

  const upcoming = live
    .filter((r) => r.scheduledAt !== null)
    .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime())[0];

  // A round with no date is an intention, not an appointment.
  return upcoming ? done('scheduled', upcoming.scheduledAt) : done('sent');
}

/** Whole days since `from`, for "waiting 9 days" style copy. */
export function daysSince(from: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}
