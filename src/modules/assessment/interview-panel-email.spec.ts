import {
  buildPanelEmail,
  formatSlotShort,
  panelNotice,
} from './interview-panel-email';

const req = {
  code: 'REQ-0042',
  designation: 'Senior Executive',
  department: 'Merchandising',
  unitFactory: 'Jinnat Textile Mills Ltd.',
};

// 11:36 and 11:51 in Dhaka (+6).
const first = new Date('2026-09-21T05:36:00Z');
const second = new Date('2026-09-21T05:51:00Z');

const round = (name: string, scheduledAt: Date | null, extra = {}) => ({
  candidate: { name },
  scheduledAt,
  mode: 'PHYSICAL',
  location: 'HR Conference Room, Level 4',
  meetLink: null,
  ...extra,
});

const render = panelNotice('FIRST', req, [
  { round: round('Rabbi Hasan', first), path: '/evaluate/tok-a' },
  { round: round('Robiul Hasan', second), path: '/evaluate/tok-b' },
]);
const email = render({ name: 'Ayesha Rahman', origin: 'https://hrm.dbl' });

describe('interview panel email', () => {
  it('lists every candidate by name, in slot order, each with their own absolute link', () => {
    const a = email.html.indexOf('Rabbi Hasan');
    const b = email.html.indexOf('Robiul Hasan');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    // The regression: bare relative paths nobody could click.
    expect(email.html).toContain('href="https://hrm.dbl/evaluate/tok-a"');
    expect(email.html).toContain('href="https://hrm.dbl/evaluate/tok-b"');
    expect(email.html).not.toMatch(/Mark here/);
  });

  it('uses the formal panel invitation copy and names the position', () => {
    expect(email.html).toContain("Dear Sir/Ma'am");
    expect(email.html).toContain('Senior Executive');
    expect(email.html).toContain('Merchandising · Jinnat Textile Mills Ltd.');
    expect(email.html).toContain('Ref: REQ-0042');
    expect(email.html).toContain('Greetings from Corporate HR.');
    expect(email.html).toContain('No. of Candidates');
    expect(email.subject).toBe(
      'Interview panel: 2 candidates — Senior Executive',
    );
  });

  it('prints Dhaka time whatever zone the server runs in', () => {
    expect(email.html).toContain('11:36 AM');
    expect(email.html).toContain('11:51 AM');
    expect(formatSlotShort(first)).toBe('21 Sept 2026, 11:36 AM');
  });

  it('keeps a readable plain-text part, one block per candidate', () => {
    expect(email.text).toContain(
      '1. Rabbi Hasan\n   Mon, 21 Sept 2026, 11:36 AM — HR Conference Room, Level 4\n   Evaluate: https://hrm.dbl/evaluate/tok-a',
    );
    expect(email.text).toContain('2. Robiul Hasan');
    expect(email.text).toContain('No. of Candidates: 2');
  });

  it('names the one candidate in the subject for a single interview', () => {
    const one = panelNotice('FINAL', req, [
      { round: round('Rabbi Hasan', null), path: '/my-interviews' },
    ])({ name: 'X', origin: 'https://hrm.dbl' });
    expect(one.subject).toBe('Interview panel: Rabbi Hasan — Senior Executive');
    expect(one.html).toContain('participate as a member of the Interview Panel');
    expect(one.html).toContain('Time to be confirmed');
  });

  it('links an online interview to its Meet', () => {
    const online = panelNotice('FIRST', req, [
      {
        round: round('Rabbi Hasan', first, {
          mode: 'ONLINE',
          location: null,
          meetLink: 'https://meet.google.com/abc-defg-hij',
        }),
        path: '/evaluate/tok-a',
      },
    ])({ name: 'X', origin: 'https://hrm.dbl' });
    expect(online.html).toContain(
      'href="https://meet.google.com/abc-defg-hij"',
    );
    expect(online.html).toContain('Online · Google Meet');
  });

  it('escapes names — applicants type their own', () => {
    const html = buildPanelEmail({
      recipientName: 'X',
      kind: 'FIRST',
      requisition: req,
      slots: [
        {
          candidateName: '<img src=x onerror=alert(1)>',
          scheduledAt: first,
          mode: 'PHYSICAL',
          location: null,
          meetLink: null,
          evaluateUrl: 'https://hrm.dbl/evaluate/t',
        },
      ],
      myInterviewsUrl: 'https://hrm.dbl/my-interviews',
      senderName: 'Nusrat Jahan',
    }).html;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Nusrat Jahan');
  });
});

describe('interview panel email — rescheduled', () => {
  const moved = panelNotice(
    'SECOND',
    req,
    [{ round: round('Rabbi Hasan', second), path: '/evaluate/tok-a' }],
    { from: first, reason: 'Panel chair travelling' },
  )({ name: 'Ayesha Rahman', origin: 'https://hrm.dbl' });

  it('says it moved, from when and why, and keeps the marking link', () => {
    expect(moved.subject).toBe(
      'Interview rescheduled: Rabbi Hasan — Senior Executive',
    );
    expect(moved.html).toContain('Interview Rescheduled');
    expect(moved.html).toContain('previously');
    expect(moved.html).toContain('11:36');
    expect(moved.html).toContain('Reason: Panel chair travelling');
    expect(moved.html).toContain('href="https://hrm.dbl/evaluate/tok-a"');
    expect(moved.text).toContain('Rescheduled - previously');
  });

  it('leaves a first invitation as it was', () => {
    expect(email.subject).not.toMatch(/rescheduled/i);
    expect(email.html).not.toContain('Interview Rescheduled');
  });
});
