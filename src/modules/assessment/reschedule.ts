/**
 * May this interview be moved to a new time — and if not, why not?
 *
 * Only an interview that has not happened yet can be rescheduled:
 * - a round recorded absent is rebooked as a new session (that is its own
 *   flow, and keeps the no-show on record);
 * - a completed or cancelled round is history;
 * - a mark from any interviewer means the candidate was in the room.
 *
 * And the new time has to be a real change, in the future. Returns the
 * sentence to show, or null when it may go ahead. Pure, so it is pinned by a
 * spec rather than rediscovered.
 */
export function rescheduleRefusal(input: {
  status: string;
  evaluationCount: number;
  from: Date | null;
  to: Date | null;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const status = input.status.toUpperCase();
  if (status === 'ABSENT') {
    return 'The candidate was recorded absent for this interview — book a new session for them instead.';
  }
  if (status === 'COMPLETED') {
    return 'This interview has already been held.';
  }
  if (status === 'CANCELLED') {
    return 'This interview was cancelled — arrange a new one instead.';
  }
  if (input.evaluationCount > 0) {
    const n = input.evaluationCount;
    return `${n} interviewer${n === 1 ? ' has' : 's have'} already marked this candidate, so the interview has taken place.`;
  }
  if (!input.to || Number.isNaN(input.to.getTime())) {
    return 'Choose the new date and time.';
  }
  if (input.to.getTime() <= now.getTime()) {
    return 'The new time has to be in the future.';
  }
  if (input.from && input.from.getTime() === input.to.getTime()) {
    return 'That is the time it is already booked for.';
  }
  return null;
}
