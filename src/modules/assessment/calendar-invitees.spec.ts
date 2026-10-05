import {
  calendarInvitees,
  rescheduleSendsCalendarUpdate,
} from './calendar-invitees';

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

  it('"Notify (Google Calendar)" off keeps only the candidate off — the panel is still invited', () => {
    expect(
      calendarInvitees({ ...base, inviteCandidate: false }).attendees,
    ).toEqual(['a@dbl-group.com']);
  });
});

describe('rescheduleSendsCalendarUpdate', () => {
  it('ticked: the update goes, candidate included', () => {
    expect(
      rescheduleSendsCalendarUpdate({
        candidateInvited: true,
        notifyCalendar: true,
      }),
    ).toBe(true);
    expect(rescheduleSendsCalendarUpdate({ candidateInvited: true })).toBe(
      true,
    );
  });

  it('unticked with the candidate on the invite: nothing goes, so nothing reaches them', () => {
    expect(
      rescheduleSendsCalendarUpdate({
        candidateInvited: true,
        notifyCalendar: false,
      }),
    ).toBe(false);
  });

  it('unticked with no candidate on the invite: the panel’s update goes as usual', () => {
    expect(
      rescheduleSendsCalendarUpdate({
        candidateInvited: false,
        notifyCalendar: false,
      }),
    ).toBe(true);
  });
});
