import { SalaryFixationService, type CommitteeScore } from './salary-fixation.service';

const mark = (
  roundId: string,
  evaluatorId: string,
  total: number,
): CommitteeScore => ({
  evaluatorId,
  evaluatorName: evaluatorId,
  roundId,
  roundKind: 'first',
  total,
  max: 50,
  submittedAt: new Date().toISOString(),
});

const avg = SalaryFixationService.averageAcrossRounds;

describe('committee average across rounds', () => {
  it('is null with nothing marked', () => {
    expect(avg([])).toBeNull();
  });

  it('is the plain mean when there is only one session', () => {
    // The panel in the screenshot: 40.5, 43.0, 33.5 -> 39.0
    expect(avg([mark('r1', 'a', 40.5), mark('r1', 'b', 43), mark('r1', 'c', 33.5)]))
      .toBeCloseTo(39.0);
  });

  it('averages each session, then the sessions', () => {
    // first  (3 people): 39.0
    // second (1 person): 45.0
    // -> 42.0, NOT the flat mean of all four (40.5)
    const scores = [
      mark('r1', 'a', 40.5),
      mark('r1', 'b', 43),
      mark('r1', 'c', 33.5),
      mark('r2', 'd', 45),
    ];
    expect(avg(scores)).toBeCloseTo(42.0);
    const flat = scores.reduce((s, c) => s + c.total, 0) / scores.length;
    expect(flat).toBeCloseTo(40.5);
  });

  it('does not let a big panel outweigh a later, smaller one', () => {
    // Five generous first-round markers against one hard final marker.
    const scores = [
      ...[48, 48, 48, 48, 48].map((t, i) => mark('r1', `p${i}`, t)),
      mark('r2', 'boss', 20),
    ];
    expect(avg(scores)).toBeCloseTo(34.0);
  });

  it('counts the same evaluator once per session they marked', () => {
    // The old code kept only an evaluator's newest row, so this person's
    // first-round mark vanished and r1 disappeared entirely.
    const scores = [mark('r1', 'a', 30), mark('r2', 'a', 40)];
    expect(avg(scores)).toBeCloseTo(35.0);
  });
});
