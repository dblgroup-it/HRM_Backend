import { InterviewService } from './interview.service';

/**
 * "Notify (Google Calendar)" — the candidate's Google Calendar invite — end to end
 * through the service's calendar sync, with Google and the database faked.
 *
 * What it pins: on, the candidate is on the invite with the panel; off, the
 * candidate is left off it and every later change keeps them off, so Google
 * never writes to them; the panel is invited either way; a silent move keeps
 * guests and reminders; and the Settings master switch still stops it all.
 */

const round = (f: {
  calendarInviteCandidate: boolean;
  calendarEventId?: string | null;
  status?: string;
}) => ({
  id: 'r1',
  kind: 'FIRST',
  mode: 'ONLINE',
  status: f.status ?? 'SCHEDULED',
  scheduledAt: new Date('2026-10-10T04:00:00Z'),
  location: null,
  calendarEventId: f.calendarEventId ?? null,
  calendarInviteCandidate: f.calendarInviteCandidate,
  candidate: { name: 'Rahim', email: 'rahim@example.com' },
  panelists: [
    {
      userId: 'p1',
      user: { email: 'a@dbl-group.com', emailNotifications: true },
    },
    {
      userId: 'p2',
      user: { email: 'b@dbl-group.com', emailNotifications: true },
    },
  ],
});

const PANEL = ['a@dbl-group.com', 'b@dbl-group.com'];
const CANDIDATE = 'rahim@example.com';

function build(emailEnabled = true) {
  const calendar = {
    isConfigured: () => true,
    createEvent: jest.fn(() =>
      Promise.resolve({
        eventId: 'ev1',
        meetLink: 'https://meet.google.com/x',
        htmlLink: null,
      }),
    ),
    updateEvent: jest.fn(() => Promise.resolve(null)),
    cancelEvent: jest.fn(() => Promise.resolve()),
  };
  const prisma = {
    interviewRound: {
      update: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ ...data }),
      ),
    },
  };
  const settings = {
    getNotificationConfig: () => Promise.resolve({ emailEnabled }),
  };
  const svc = new InterviewService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    calendar as never,
    settings as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  // The sync helpers are private; they are what every path goes through.
  const sync = svc as unknown as {
    syncCalendarCreate(r: unknown, d: string): Promise<unknown>;
    syncCalendarUpdate(
      r: unknown,
      d: string,
      sendUpdates?: boolean,
    ): Promise<unknown>;
  };
  return { calendar, sync };
}

type EventInput = {
  attendees: string[];
  notify: boolean;
  reminders: boolean;
  withMeet: boolean;
};
const created = (c: ReturnType<typeof build>['calendar']) =>
  (c.createEvent.mock.calls[0] as unknown as [EventInput])[0];
const updated = (c: ReturnType<typeof build>['calendar']) =>
  (c.updateEvent.mock.calls[0] as unknown as [string, EventInput])[1];

describe('Notify (Google Calendar)', () => {
  it('on: the candidate is invited along with the panel', async () => {
    const t = build();
    await t.sync.syncCalendarCreate(
      round({ calendarInviteCandidate: true }),
      'Officer',
    );
    expect(created(t.calendar)).toMatchObject({
      attendees: [...PANEL, CANDIDATE],
      notify: true,
      reminders: true,
    });
  });

  it('off: the candidate is left off; the panel is invited as always', async () => {
    const t = build();
    await t.sync.syncCalendarCreate(
      round({ calendarInviteCandidate: false }),
      'Officer',
    );
    expect(created(t.calendar)).toMatchObject({
      attendees: PANEL,
      notify: true,
      withMeet: true,
    });
  });

  describe('off: later changes never bring the candidate in', () => {
    it('an edit updates the panel and leaves the candidate out', async () => {
      const t = build();
      await t.sync.syncCalendarUpdate(
        round({ calendarInviteCandidate: false, calendarEventId: 'ev1' }),
        'Officer',
      );
      expect(updated(t.calendar).attendees).toEqual(PANEL);
    });

    it('an event made late (no event yet) leaves the candidate out too', async () => {
      const t = build();
      await t.sync.syncCalendarUpdate(
        round({ calendarInviteCandidate: false }),
        'Officer',
      );
      expect(created(t.calendar).attendees).toEqual(PANEL);
    });

    it('a cancellation cannot reach the candidate — they were never on it', async () => {
      const t = build();
      await t.sync.syncCalendarUpdate(
        round({
          calendarInviteCandidate: false,
          calendarEventId: 'ev1',
          status: 'CANCELLED',
        }),
        'Officer',
      );
      // The panel is told, as before.
      expect(t.calendar.cancelEvent).toHaveBeenCalledWith('ev1', true);
    });
  });

  it('a silent move keeps everyone on it and their reminders, and writes to nobody', async () => {
    const t = build();
    await t.sync.syncCalendarUpdate(
      round({ calendarInviteCandidate: true, calendarEventId: 'ev1' }),
      'Officer',
      false,
    );
    expect(updated(t.calendar)).toMatchObject({
      attendees: [...PANEL, CANDIDATE],
      notify: false,
      reminders: true,
    });
  });

  it('the Settings master switch still overrides everything', async () => {
    const t = build(false);
    await t.sync.syncCalendarCreate(
      round({ calendarInviteCandidate: true }),
      'Officer',
    );
    expect(created(t.calendar)).toMatchObject({ attendees: [], notify: false });
  });
});
