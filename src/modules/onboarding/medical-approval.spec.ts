import {
  applyCmoDecision,
  decisionNoteError,
  submissionBlocker,
} from './medical-approval';

describe('applyCmoDecision', () => {
  it('approving a proposed clearance clears the candidate', () => {
    expect(applyCmoDecision('approve', 'cleared')).toMatchObject({
      status: 'cleared',
      decided: true,
    });
  });

  it('approving a proposed rejection rejects the candidate', () => {
    // The layer covers unfit results too — ending a hire on medical grounds is
    // the more consequential of the two decisions.
    expect(applyCmoDecision('approve', 'rejected')).toMatchObject({
      status: 'rejected',
      decided: true,
    });
  });

  it('overturning a proposed clearance rejects it, and says so', () => {
    const t = applyCmoDecision('reject', 'cleared');
    expect(t.status).toBe('rejected');
    expect(t.summary).toContain('overturned');
  });

  it('returning sends it back to pending, undecided', () => {
    expect(applyCmoDecision('return', 'cleared')).toMatchObject({
      status: 'pending',
      decided: false,
    });
  });

  it('never produces "submitted" — a decision always leaves the queue', () => {
    for (const d of ['approve', 'reject', 'return'] as const) {
      for (const p of ['cleared', 'rejected'] as const) {
        expect(applyCmoDecision(d, p).status).not.toBe('submitted');
      }
    }
  });
});

describe('decisionNoteError', () => {
  it('needs no note to agree with the examining officer', () => {
    expect(decisionNoteError('approve', undefined)).toBeNull();
  });

  it('demands a reason for overturning a finding', () => {
    expect(decisionNoteError('reject', '')).toContain('reason');
    expect(decisionNoteError('reject', '  ')).not.toBeNull();
  });

  it('demands an instruction when sending it back', () => {
    expect(decisionNoteError('return', null)).toContain('correct');
  });

  it('accepts a real note', () => {
    expect(
      decisionNoteError('reject', 'BP consistently above threshold'),
    ).toBeNull();
    expect(decisionNoteError('return', 'Re-check vision, left eye')).toBeNull();
  });
});

describe('submissionBlocker', () => {
  it('allows a genuine submission through', () => {
    expect(
      submissionBlocker({
        medicalStatus: 'submitted',
        medicalProposed: 'cleared',
      }),
    ).toBeNull();
  });

  it('refuses one nobody has submitted', () => {
    expect(
      submissionBlocker({ medicalStatus: 'pending', medicalProposed: null }),
    ).toContain('No medical finding');
  });

  it('refuses one already decided — the bulk-action race', () => {
    // Two CMOs working the same queue: the second must be told, not silently
    // allowed to overwrite a decision.
    expect(
      submissionBlocker({
        medicalStatus: 'cleared',
        medicalProposed: 'cleared',
      }),
    ).toContain('already cleared');
    expect(
      submissionBlocker({
        medicalStatus: 'rejected',
        medicalProposed: 'rejected',
      }),
    ).toContain('already rejected');
  });

  it('refuses a submission with no recorded finding', () => {
    expect(
      submissionBlocker({ medicalStatus: 'submitted', medicalProposed: null }),
    ).not.toBeNull();
  });
});
