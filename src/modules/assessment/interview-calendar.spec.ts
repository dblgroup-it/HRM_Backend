import { InterviewService } from './interview.service';

/**
 * "Notify on calendar", end to end through the service's calendar sync, with
 * Google and the database faked.
 *
 * What it pins: on, the panel (and the candidate when emailed) are invited
 * and Google writes to them; off, the event is still made — it carries an
 * online round's Meet link — but invites nobody and sends nothing; a
 * reschedule with the box unticked moves the event without writing to anyone
 * yet keeps who is on it and their reminders; and a cancellation follows the
 * round's choice.
 */

type Flags = {
  calendarNotify: boolean;
  calendarInviteCandidate: boolean;
  calendarEventId?: string | null;
  status?: string;
};

const round = (f: Flags) => ({
  id: 'r1',
  kind: 'FIRST',
  mode: 'ONLINE',
  status: f.status ?? 'SCHEDULED',
  scheduledAt: new Date('2026-10-10T04:00:00Z'),
  location: null,
  calendarEventId: f.calendarEventId ?? null,
  calendarNotify: f.calendarNotify,
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

describe('Notify on calendar', () => {
  it('on: invites the panel and the emailed candidate, and Google writes to them', async () => {
    const t = build();
    await t.sync.syncCalendarCreate(
      round({ calendarNotify: true, calendarInviteCandidate: true }),
      'Officer',
    );
    expect(created(t.calendar)).toMatchObject({
      attendees: ['a@dbl-group.com', 'b@dbl-group.com', 'rahim@example.com'],
      notify: true,
      reminders: true,
    });
  });

  it('on, candidate not emailed: the candidate stays off the invite', async () => {
    const t = build();
    await t.sync.syncCalendarCreate(
      round({ calendarNotify: true, calendarInviteCandidate: false }),
      'Officer',
    );
    expect(created(t.calendar).attendees).toEqual([
      'a@dbl-group.com',
      'b@dbl-group.com',
    ]);
  });

  it('off: the event is still made, with its Meet link, but invites nobody', async () => {
    const t = build();
    await t.sync.syncCalendarCreate(
      round({ calendarNotify: false, calendarInviteCandidate: true }),
      'Officer',
    );
    expect(created(t.calendar)).toMatchObject({
      attendees: [],
      notify: false,
      reminders: false,
      withMeet: true,
    });
  });

  it('a later change follows the round’s choice — no candidate it was not asked to invite', async () => {
    const t = build();
    await t.sync.syncCalendarUpdate(
      round({
        calendarNotify: true,
        calendarInviteCandidate: false,
        calendarEventId: 'ev1',
      }),
      'Officer',
    );
    expect(updated(t.calendar)).toMatchObject({
      attendees: ['a@dbl-group.com', 'b@dbl-group.com'],
      notify: true,
    });
  });

  it('a reschedule with the box unticked moves the event silently, keeping guests and reminders', async () => {
    const t = build();
    await t.sync.syncCalendarUpdate(
      round({
        calendarNotify: true,
        calendarInviteCandidate: true,
        calendarEventId: 'ev1',
      }),
      'Officer',
      false,
    );
    expect(updated(t.calendar)).toMatchObject({
      attendees: ['a@dbl-group.com', 'b@dbl-group.com', 'rahim@example.com'],
      notify: false,
      reminders: true,
    });
  });

  it('a cancellation is silent when the round was arranged without invites', async () => {
    const t = build();
    await t.sync.syncCalendarUpdate(
      round({
        calendarNotify: false,
        calendarInviteCandidate: true,
        calendarEventId: 'ev1',
        status: 'CANCELLED',
      }),
      'Officer',
    );
    expect(t.calendar.cancelEvent).toHaveBeenCalledWith('ev1', false);
  });

  it('a cancellation is announced when the round had invites', async () => {
    const t = build();
    await t.sync.syncCalendarUpdate(
      round({
        calendarNotify: true,
        calendarInviteCandidate: true,
        calendarEventId: 'ev1',
        status: 'CANCELLED',
      }),
      'Officer',
    );
    expect(t.calendar.cancelEvent).toHaveBeenCalledWith('ev1', true);
  });

  describe('unticked: nothing reaches anyone, whatever happens to the round later', () => {
    const off = { calendarNotify: false, calendarInviteCandidate: true };

    it('an edit or a move invites nobody and sends nothing', async () => {
      for (const sendUpdates of [true, false]) {
        const t = build();
        await t.sync.syncCalendarUpdate(
          round({ ...off, calendarEventId: 'ev1' }),
          'Officer',
          sendUpdates,
        );
        expect(updated(t.calendar)).toMatchObject({
          attendees: [],
          notify: false,
          reminders: false,
        });
      }
    });

    it('an event made late (no event yet) invites nobody either', async () => {
      const t = build();
      await t.sync.syncCalendarUpdate(round(off), 'Officer');
      expect(created(t.calendar)).toMatchObject({
        attendees: [],
        notify: false,
      });
    });
  });

  it('the Settings master switch still overrides everything', async () => {
    const t = build(false);
    await t.sync.syncCalendarCreate(
      round({ calendarNotify: true, calendarInviteCandidate: true }),
      'Officer',
    );
    expect(created(t.calendar)).toMatchObject({ attendees: [], notify: false });
  });
});
