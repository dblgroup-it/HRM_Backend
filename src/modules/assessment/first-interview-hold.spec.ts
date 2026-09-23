import { firstInterviewHold } from './first-interview-hold';

/**
 * Regression cover for a factory interview that ran twice.
 *
 * A candidate sent to a JTML colleague for their first interview appeared on
 * Head of Talent Acquisition's own Interviews tab the moment that colleague
 * scheduled the round — because scheduling advances the candidate to the
 * Interview stage, and the tab lists everyone at that stage. The recruiter
 * could reschedule it, add panelists to it, remove it, or reject the
 * candidate out from under the person who had been asked to interview them.
 *
 * The release is the delegate's verdict, not their marks.
 */
const karim = { id: 'u1', name: 'Md. Karim' };
const nusrat = { id: 'u2', name: 'Nusrat Jahan' };

const open = (to = karim) => ({ revokedAt: null, delegatedTo: to });

describe('firstInterviewHold', () => {
  it('holds a candidate whose first interview is out with a delegate', () => {
    expect(
      firstInterviewHold({
        stage: 'INTERVIEW',
        rejectedAt: null,
        interviewDelegations: [open()],
      }),
    ).toEqual({ delegates: [karim] });
  });

  it('does not hold a candidate who was never handed to anybody', () => {
    expect(
      firstInterviewHold({
        stage: 'INTERVIEW',
        rejectedAt: null,
        interviewDelegations: [],
      }),
    ).toBeNull();
  });

  it('does not hold when the query did not ask for delegations', () => {
    expect(
      firstInterviewHold({ stage: 'INTERVIEW', rejectedAt: null }),
    ).toBeNull();
  });

  it('holds while the marks are in but the verdict is not', () => {
    // `delegationProgress` calls this stage "marked" and treats it as complete
    // for the scoreboard. It is NOT a release here: the round is still the
    // delegate's until they say what came of it.
    expect(
      firstInterviewHold({
        stage: 'INTERVIEW',
        rejectedAt: null,
        interviewDelegations: [open()],
      }),
    ).not.toBeNull();
  });

  it('releases once the delegate puts the candidate through', () => {
    expect(
      firstInterviewHold({
        stage: 'FINAL',
        rejectedAt: null,
        interviewDelegations: [open()],
      }),
    ).toBeNull();
  });

  it('releases once the delegate turns the candidate down', () => {
    expect(
      firstInterviewHold({
        stage: 'REJECTED',
        rejectedAt: new Date('2026-09-20T10:00:00Z'),
        interviewDelegations: [open()],
      }),
    ).toBeNull();
  });

  it('releases a candidate who has since been hired', () => {
    expect(
      firstInterviewHold({
        stage: 'SELECTED',
        rejectedAt: null,
        interviewDelegations: [open()],
      }),
    ).toBeNull();
  });

  it('releases when the hand-off is withdrawn', () => {
    // Withdrawing the delegation is how the recruiter takes the work back —
    // a deliberate act with a record, unlike quietly editing the round.
    expect(
      firstInterviewHold({
        stage: 'INTERVIEW',
        rejectedAt: null,
        interviewDelegations: [
          { revokedAt: new Date('2026-09-21T09:00:00Z'), delegatedTo: karim },
        ],
      }),
    ).toBeNull();
  });

  it('ignores a withdrawn hand-off beside a live one', () => {
    expect(
      firstInterviewHold({
        stage: 'INTERVIEW',
        rejectedAt: null,
        interviewDelegations: [
          { revokedAt: new Date('2026-09-21T09:00:00Z'), delegatedTo: nusrat },
          open(karim),
        ],
      }),
    ).toEqual({ delegates: [karim] });
  });

  it('names everyone the candidate was handed to, once each', () => {
    expect(
      firstInterviewHold({
        stage: 'INTERVIEW',
        rejectedAt: null,
        interviewDelegations: [open(karim), open(nusrat), open(karim)],
      }),
    ).toEqual({ delegates: [karim, nusrat] });
  });

  it('holds a candidate handed over before anything was arranged', () => {
    expect(
      firstInterviewHold({
        stage: 'SHORTLISTED',
        rejectedAt: null,
        interviewDelegations: [open()],
      }),
    ).toEqual({ delegates: [karim] });
  });
});
