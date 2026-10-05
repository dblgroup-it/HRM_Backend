/**
 * Who a round's Google Calendar event invites.
 *
 * Calendar invites and their reminders are email Google sends on our behalf —
 * they never pass through `MailService`, so the email rules have to be applied
 * here as well or they leak around both switches:
 * - **Settings master switch off** → nobody is invited and Google is told to
 *   send nothing. The event is still kept on the recruitment calendar, which
 *   is where an online round's Meet link comes from.
 * - **A panelist who turned email off on their profile** is left off the
 *   invite. An attendee's reminders come from their own calendar, so leaving
 *   them off is the only way to stop those too.
 *
 * The candidate is not a user and has no preference: they are on the invite
 * only when the organizer left "Notify (Google Calendar)" ticked for the round.
 * That choice is the candidate's alone — the panel is invited either way.
 */
export interface CalendarInviteeInput {
  emailEnabled: boolean;
  panelists: { email: string | null; emailNotifications: boolean }[];
  candidateEmail: string | null;
  /** "Notify (Google Calendar)" on this round — the candidate's invite only. */
  inviteCandidate: boolean;
}

export interface CalendarInvitees {
  attendees: string[];
  /** False → Google sends no invite, update or cancellation mail. */
  notify: boolean;
}

export function calendarInvitees(
  input: CalendarInviteeInput,
): CalendarInvitees {
  if (!input.emailEnabled) return { attendees: [], notify: false };
  const attendees = input.panelists
    .filter((p) => p.emailNotifications && p.email)
    .map((p) => p.email as string);
  if (input.inviteCandidate && input.candidateEmail) {
    attendees.push(input.candidateEmail);
  }
  return { attendees, notify: true };
}

/**
 * Whether a reschedule lets Google send its calendar update.
 *
 * "Notify (Google Calendar)" unticked means the candidate hears nothing from Google
 * about the move. Google writes to every guest or to none, so when the
 * candidate is on the invite the move goes out silently (the panel still gets
 * this system's own notice); when they are not, the panel's calendar update
 * goes as usual — there is no candidate on it to reach.
 */
export function rescheduleSendsCalendarUpdate(input: {
  candidateInvited: boolean;
  notifyCalendar?: boolean;
}): boolean {
  return input.notifyCalendar !== false || !input.candidateInvited;
}
