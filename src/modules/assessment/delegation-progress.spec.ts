import { delegationProgress, daysSince } from './delegation-progress';
import type { ProgressInput } from './delegation-progress';

/**
 * The delegation scoreboard is only worth having if "waiting" means the same
 * thing to the person who sent the work and the person doing it. These pin the
 * vocabulary down.
 */
describe('delegationProgress', () => {
  const NOW = new Date('2026-09-14T10:00:00Z');
  const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
  const ahead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

  const base: ProgressInput = {
    candidateStage: 'SHORTLISTED',
    rejectedAt: null,
    rounds: [],
  };
  const at = (input: Partial<ProgressInput>) =>
    delegationProgress({ ...base, ...input }, NOW);

  it('is "sent" when nothing has been arranged', () => {
    expect(at({}).stage).toBe('sent');
    expect(at({}).complete).toBe(false);
  });

  it('is "scheduled" once a future sitting exists', () => {
    const p = at({
      rounds: [
        { status: 'SCHEDULED', scheduledAt: ahead(2), evaluationCount: 0 },
      ],
    });
    expect(p.stage).toBe('scheduled');
    expect(p.scheduledAt).toBe(ahead(2).toISOString());
  });

  it('treats a round with no date as not yet arranged', () => {
    // An intention, not an appointment — the interviewer still owes a date.
    expect(
      at({
        rounds: [
          { status: 'SCHEDULED', scheduledAt: null, evaluationCount: 0 },
        ],
      }).stage,
    ).toBe('sent');
  });

  it('is "interviewed" once the slot has passed, even if nobody closed it', () => {
    // The status flag is frequently left on SCHEDULED; the clock is the truth.
    expect(
      at({
        rounds: [
          { status: 'SCHEDULED', scheduledAt: ago(3), evaluationCount: 0 },
        ],
      }).stage,
    ).toBe('interviewed');
  });

  it('is "interviewed" when the round is explicitly COMPLETED', () => {
    expect(
      at({
        rounds: [
          { status: 'COMPLETED', scheduledAt: ago(1), evaluationCount: 0 },
        ],
      }).stage,
    ).toBe('interviewed');
  });

  it('is "marked" as soon as one panelist has submitted', () => {
    const p = at({
      rounds: [
        { status: 'COMPLETED', scheduledAt: ago(1), evaluationCount: 1 },
      ],
    });
    expect(p.stage).toBe('marked');
    expect(p.complete).toBe(true);
  });

  it('ignores a cancelled round — that is back to square one', () => {
    expect(
      at({
        rounds: [
          { status: 'CANCELLED', scheduledAt: ago(5), evaluationCount: 0 },
        ],
      }).stage,
    ).toBe('sent');
  });

  it('ignores a no-show — the slot passed, but nobody was interviewed', () => {
    expect(
      at({
        rounds: [
          { status: 'ABSENT', scheduledAt: ago(2), evaluationCount: 0 },
        ],
      }).stage,
    ).toBe('sent');
  });

  it('follows the session rebooked after a no-show', () => {
    const p = at({
      rounds: [
        { status: 'ABSENT', scheduledAt: ago(2), evaluationCount: 0 },
        { status: 'SCHEDULED', scheduledAt: ahead(3), evaluationCount: 0 },
      ],
    });
    expect(p.stage).toBe('scheduled');
    expect(p.scheduledAt).toBe(ahead(3).toISOString());
  });

  it('takes the earliest upcoming sitting when several are booked', () => {
    const p = at({
      rounds: [
        { status: 'SCHEDULED', scheduledAt: ahead(9), evaluationCount: 0 },
        { status: 'SCHEDULED', scheduledAt: ahead(2), evaluationCount: 0 },
      ],
    });
    expect(p.scheduledAt).toBe(ahead(2).toISOString());
  });

  describe('a decision outranks everything', () => {
    it.each(['FINAL', 'SELECTED', 'REJECTED'] as const)(
      'is "decided" at stage %s',
      (candidateStage) => {
        const p = at({ candidateStage });
        expect(p.stage).toBe('decided');
        expect(p.complete).toBe(true);
      },
    );

    it('is "decided" when the candidate was rejected, whatever the rounds say', () => {
      expect(
        at({
          rejectedAt: ago(1),
          rounds: [
            { status: 'SCHEDULED', scheduledAt: ahead(3), evaluationCount: 0 },
          ],
        }).stage,
      ).toBe('decided');
    });
  });

  it('carries a human label for every stage', () => {
    expect(at({}).label).toBe('No action yet');
    expect(
      at({
        rounds: [
          { status: 'SCHEDULED', scheduledAt: ahead(1), evaluationCount: 0 },
        ],
      }).label,
    ).toBe('Interview scheduled');
  });
});

describe('daysSince', () => {
  const NOW = new Date('2026-09-14T10:00:00Z');

  it('counts whole days', () => {
    expect(daysSince(new Date('2026-09-05T10:00:00Z'), NOW)).toBe(9);
    expect(daysSince(new Date('2026-09-14T09:00:00Z'), NOW)).toBe(0);
  });

  it('never goes negative for a future timestamp', () => {
    // Clock skew between the app server and the database is not a reason to
    // tell somebody a candidate has been waiting minus two days.
    expect(daysSince(new Date('2026-09-16T10:00:00Z'), NOW)).toBe(0);
  });
});
