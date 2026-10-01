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
 * The candidate is not a user and has no preference; only the master switch
 * applies to them.
 */
export interface CalendarInviteeInput {
  emailEnabled: boolean;
  panelists: { email: string | null; emailNotifications: boolean }[];
  candidateEmail: string | null;
  inviteCandidate: boolean;
}

export interface CalendarInvitees {
  attendees: string[];
  /** False → Google sends no invite, update or cancellation mail. */
  notify: boolean;
}

export function calendarInvitees(input: CalendarInviteeInput): CalendarInvitees {
  if (!input.emailEnabled) return { attendees: [], notify: false };
  const attendees = input.panelists
    .filter((p) => p.emailNotifications && p.email)
    .map((p) => p.email as string);
  if (input.inviteCandidate && input.candidateEmail) {
    attendees.push(input.candidateEmail);
  }
  return { attendees, notify: true };
}
