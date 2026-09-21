/**
 * The email a panelist receives when they are put on an interview panel.
 *
 * One layout for one candidate or a whole batch: a row per candidate, in slot
 * order, each with its own "Evaluate" button. It used to be the generic
 * notification wrapper around a plain-text list, and HTML collapses newlines —
 * a batch arrived as one run-on paragraph with bare `/evaluate/…` paths that
 * were not even clickable.
 *
 * Pure: no services, so the content is pinned by a spec.
 */

/** Interviews happen in Bangladesh; the server's own zone is irrelevant. */
const TIMEZONE = 'Asia/Dhaka';

export interface PanelEmailSlot {
  candidateName: string;
  scheduledAt: Date | null;
  mode: string;
  location: string | null;
  meetLink: string | null;
  /** Absolute URL of THIS panelist's marking sheet for this candidate. */
  evaluateUrl: string;
}

export interface PanelEmailInput {
  recipientName: string;
  /** InterviewKind — FIRST / SECOND / FINAL. */
  kind: string;
  requisition: {
    code: string;
    designation: string;
    department: string;
    unitFactory: string;
  };
  slots: PanelEmailSlot[];
  myInterviewsUrl: string;
}

export interface PanelEmail {
  subject: string;
  html: string;
  text: string;
}

/** "Mon, 21 Sep 2026" and "11:36 AM", in Dhaka time. */
export function formatInterviewSlot(
  at: Date | null,
): { date: string; time: string } | null {
  if (!at) return null;
  const d = new Date(at);
  return {
    date: d.toLocaleDateString('en-GB', {
      timeZone: TIMEZONE,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    time: d
      .toLocaleTimeString('en-US', {
        timeZone: TIMEZONE,
        hour: 'numeric',
        minute: '2-digit',
      })
      .toUpperCase(),
  };
}

/** One line for the in-app bell, where there is room for names, not links. */
export function formatSlotShort(at: Date | null): string {
  const s = formatInterviewSlot(at);
  return s ? `${s.date.replace(/^\w+, /, '')}, ${s.time}` : 'time TBC';
}

const KIND_LABEL: Record<string, string> = {
  FIRST: 'first',
  SECOND: 'second',
  FINAL: 'final',
};

const isUrl = (s: string | null | undefined): s is string =>
  Boolean(s && /^https?:\/\//i.test(s.trim()));

/** Where to join an online interview: the Meet link, else a pasted URL. */
function joinLink(slot: PanelEmailSlot): string | null {
  if (slot.mode !== 'ONLINE') return null;
  if (isUrl(slot.meetLink)) return slot.meetLink.trim();
  return isUrl(slot.location) ? slot.location.trim() : null;
}

function venue(slot: PanelEmailSlot): string {
  if (slot.mode === 'ONLINE') {
    if (isUrl(slot.meetLink)) return 'Online · Google Meet';
    const where = slot.location?.trim();
    return where && !isUrl(where) ? `Online · ${where}` : 'Online';
  }
  return slot.location?.trim() || 'In person';
}

export function buildPanelEmail(input: PanelEmailInput): PanelEmail {
  const { requisition: req, slots } = input;
  const kind = KIND_LABEL[input.kind] ?? input.kind.toLowerCase();
  const n = slots.length;
  const today = new Date().toLocaleDateString('en-GB', {
    timeZone: TIMEZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const position = [req.designation, req.department, req.unitFactory]
    .map((s) => s?.trim())
    .filter(Boolean);

  const subject =
    n === 1
      ? `Interview panel: ${slots[0].candidateName} — ${req.designation}`
      : `Interview panel: ${n} candidates — ${req.designation}`;

  const intro =
    n === 1
      ? `You have been nominated to the panel for the following ${kind} interview.`
      : `You have been nominated to the panel for the following ${n} ${kind} interviews, listed in order of their time slots.`;

  const rows = slots
    .map((slot, i) => {
      const at = formatInterviewSlot(slot.scheduledAt);
      const when = at
        ? `<span style="white-space:nowrap">${esc(at.date)}</span> &nbsp;·&nbsp; <strong style="color:#33475b;white-space:nowrap">${esc(at.time)}</strong>`
        : 'Time to be confirmed';
      const link = joinLink(slot);
      const where = link
        ? `<a href="${attr(link)}" style="color:#1877c0;text-decoration:none">${esc(venue(slot))}</a>`
        : esc(venue(slot));
      const last = i === n - 1;
      return `
      <tr>
        <td style="padding:16px 0;${last ? '' : 'border-bottom:1px solid #e9eef4;'}width:34px;vertical-align:top">
          <div style="width:26px;height:26px;border-radius:13px;background:#eaf3fb;color:#1877c0;font-size:12px;font-weight:700;line-height:26px;text-align:center">${i + 1}</div>
        </td>
        <td style="padding:16px 12px 16px 0;${last ? '' : 'border-bottom:1px solid #e9eef4;'}vertical-align:top">
          <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a202c">${esc(slot.candidateName)}</p>
          <p style="margin:0 0 2px;font-size:13px;color:#6b7c93">${when}</p>
          <p style="margin:0;font-size:12px;color:#6b7c93">${where}</p>
        </td>
        <td style="padding:16px 0;${last ? '' : 'border-bottom:1px solid #e9eef4;'}vertical-align:middle;text-align:right;white-space:nowrap">
          <a href="${attr(slot.evaluateUrl)}" style="display:inline-block;background:#1877c0;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">Evaluate</a>
        </td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#1a202c">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.08)">

  <tr><td style="background:linear-gradient(to right,#1877c0,#8cc63f);height:4px;font-size:0;line-height:0">&nbsp;</td></tr>

  <tr><td style="background:#ffffff;padding:24px 28px 18px;border-bottom:1px solid #e9eef4">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:middle">
          <p style="margin:0;font-size:18px;font-weight:700;color:#1877c0;letter-spacing:-0.2px">DBL Group</p>
          <p style="margin:3px 0 0;font-size:12px;color:#6b7c93;letter-spacing:0.3px">HR Department &nbsp;·&nbsp; Interview Panel Notice</p>
        </td>
        <td style="vertical-align:middle;text-align:right">
          <p style="margin:0;font-size:12px;color:#6b7c93;white-space:nowrap">${esc(today)}</p>
          <p style="margin:3px 0 0;font-size:11px;color:#a0aec0;white-space:nowrap">Ref: ${esc(req.code)}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="background:#ffffff;padding:28px 28px 32px">

    <p style="margin:0 0 6px;font-size:15px;color:#1a202c">Dear <strong>${esc(input.recipientName)}</strong>,</p>
    <p style="margin:0 0 24px;font-size:14px;color:#4a5568;line-height:1.7">${esc(intro)}</p>

    <div style="background:#f7faff;border:1px solid #c3d9f8;border-radius:8px;padding:14px 20px;margin-bottom:8px">
      <p style="margin:0 0 2px;font-size:11px;color:#6b7c93;text-transform:uppercase;letter-spacing:0.6px">Position</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#1877c0">${esc(position[0] ?? '')}</p>
      ${position.length > 1 ? `<p style="margin:2px 0 0;font-size:13px;color:#6b7c93">${esc(position.slice(1).join(' · '))}</p>` : ''}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      ${rows}
    </table>

    <p style="margin:0 0 8px;font-size:13px;color:#4a5568;line-height:1.7">
      Each <strong>Evaluate</strong> button opens your own marking sheet for that candidate. No sign-in is needed, so please do not forward this email.
    </p>
    <p style="margin:0 0 24px;font-size:13px;color:#4a5568;line-height:1.7">
      You can also find all of your interviews under
      <a href="${attr(input.myInterviewsUrl)}" style="color:#1877c0;text-decoration:none;font-weight:600">My Interviews</a> in DBL HRM.
    </p>

    <p style="margin:0;font-size:14px;color:#4a5568;line-height:1.6">Best regards,<br><strong style="color:#1a202c">DBL Group Recruitment</strong></p>
  </td></tr>

  <tr><td style="background:#f8fafc;padding:16px 28px;border-top:1px solid #e9eef4">
    <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6">
      You receive these because email notifications are on. Turn them off in Settings → Notifications.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const textRows = slots.map((slot, i) => {
    const at = formatInterviewSlot(slot.scheduledAt);
    const when = at ? `${at.date}, ${at.time}` : 'Time to be confirmed';
    const link = joinLink(slot);
    return [
      `${i + 1}. ${slot.candidateName}`,
      `   ${when} — ${venue(slot)}${link ? ` (${link})` : ''}`,
      `   Evaluate: ${slot.evaluateUrl}`,
    ].join('\n');
  });

  const text = [
    `Dear ${input.recipientName},`,
    '',
    intro,
    '',
    `Position: ${position.join(' · ')}`,
    `Ref: ${req.code}`,
    '',
    textRows.join('\n\n'),
    '',
    'Each Evaluate link opens your own marking sheet for that candidate. No sign-in is needed, so please do not forward this email.',
    `All your interviews: ${input.myInterviewsUrl}`,
    '',
    'Best regards,',
    'DBL Group Recruitment',
  ].join('\n');

  return { subject, html, text };
}

/**
 * The `email` renderer for a panel notification, in the shape
 * `NotificationsService.notify` takes. `path` is the panelist's OWN
 * evaluation link for that round — they differ per person, so one of these
 * is built per recipient.
 */
export function panelNotice(
  kind: string,
  requisition: PanelEmailInput['requisition'],
  slots: {
    round: {
      candidate: { name: string };
      scheduledAt: Date | null;
      mode: string;
      location: string | null;
      meetLink: string | null;
    };
    path: string;
  }[],
) {
  return (to: { name: string; origin: string }): PanelEmail =>
    buildPanelEmail({
      recipientName: to.name,
      kind,
      requisition,
      slots: slots.map(({ round, path }) => ({
        candidateName: round.candidate.name,
        scheduledAt: round.scheduledAt,
        mode: round.mode,
        location: round.location,
        meetLink: round.meetLink,
        evaluateUrl: `${to.origin}${path}`,
      })),
      myInterviewsUrl: `${to.origin}/my-interviews`,
    });
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only http(s) links go into an href — a stored location is free text. */
function attr(url: string): string {
  return isUrl(url) ? esc(url.trim()) : '#';
}
