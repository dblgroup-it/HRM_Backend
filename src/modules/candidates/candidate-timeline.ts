/** One thing that happened to this hire, in the order it happened. */
export interface TimelineEvent {
  /** ISO timestamp. Events without one are dropped rather than guessed at. */
  at: string;
  /** Which part of the lifecycle this belongs to. */
  phase:
    | 'requisition'
    | 'recruitment'
    | 'assessment'
    | 'approval'
    | 'onboarding';
  title: string;
  detail?: string;
  /** Who did it, where the record names someone. */
  actor?: string;
}

const PHASE_ORDER: Record<TimelineEvent['phase'], number> = {
  requisition: 0,
  recruitment: 1,
  assessment: 2,
  approval: 3,
  onboarding: 4,
};

/**
 * Put the events in the order they happened.
 *
 * Several records share a timestamp to the second — a decision and the
 * notification it triggers, most often — so ties fall back to the phase, which
 * keeps "offer accepted" below "offer sent" instead of alternating between
 * prints of the same record.
 */
export function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort(
    (a, b) =>
      a.at.localeCompare(b.at) || PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase],
  );
}

/** Add an event only when the record actually carries a date. */
export function pushIf(
  events: TimelineEvent[],
  at: Date | string | null | undefined,
  event: Omit<TimelineEvent, 'at'>,
): void {
  if (!at) return;
  events.push({ ...event, at: typeof at === 'string' ? at : at.toISOString() });
}
