import { calendarInvitees } from './calendar-invitees';

describe('calendarInvitees', () => {
  const base = {
    emailEnabled: true,
    panelists: [
      { email: 'a@dbl-group.com', emailNotifications: true },
      { email: 'b@dbl-group.com', emailNotifications: false },
      { email: null, emailNotifications: true },
    ],
    candidateEmail: 'cand@example.com',
    inviteCandidate: true,
  };

  it('invites panelists who take email, and the candidate', () => {
    expect(calendarInvitees(base)).toEqual({
      attendees: ['a@dbl-group.com', 'cand@example.com'],
      notify: true,
    });
  });

  it('leaves off a panelist who turned email off on their profile', () => {
    expect(calendarInvitees(base).attendees).not.toContain('b@dbl-group.com');
  });

  it('invites nobody and sends nothing when the master switch is off', () => {
    expect(calendarInvitees({ ...base, emailEnabled: false })).toEqual({
      attendees: [],
      notify: false,
    });
  });

  it('skips the candidate when asked to', () => {
    expect(
      calendarInvitees({ ...base, inviteCandidate: false }).attendees,
    ).toEqual(['a@dbl-group.com']);
  });
});
