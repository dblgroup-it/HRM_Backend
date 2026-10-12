/**
 * The two emails of "Notify IT", written the way DBL's IT requests are
 * written by hand.
 *
 * The request (HR → IT) asks for the new hire's work email account and, when
 * the hire replaces somebody, for the leaver's account to be deleted — two
 * numbered requests in one message, signed by the person sending it. The
 * reply ("completed") goes back to that person, listing what was created and
 * deleted, signed by whoever in IT confirmed it.
 *
 * Both are rendered here as plain text and HTML from the same blocks, so the
 * two versions cannot say different things. Decorator-free so specs import it.
 */
import { esc } from '../integrations/mail/branded-email';
import { firstName } from '../../common/util/first-name';

/** Somebody whose account IT is asked to delete. */
export interface ItLeaver {
  name: string;
  code: string | null;
  email: string;
  /** Resigned / Terminated / Retired… as the requisition recorded it. */
  reason: string | null;
}

/** A leaver as IT answered: deleted, or not. */
export interface ItLeaverDone extends ItLeaver {
  deleted: boolean;
}

export interface ItRequestMail {
  /** "Dear <salutation>," — set on Integrations. */
  salutation: string;
  unit: string;
  lineOfBusiness?: string | null;
  employeeName: string;
  employeeId?: string | null;
  designation?: string | null;
  department?: string | null;
  /** Blank means IT chooses. */
  preferredEmail?: string | null;
  platform: string;
  joiningDate?: Date | null;
  purpose?: string | null;
  deletions: ItLeaver[];
  /** Who is asking — the signature. */
  requester: {
    name: string;
    designation?: string | null;
    department?: string | null;
    phone?: string | null;
  };
  /** The confirmation link; null in a preview, before one exists. */
  confirmUrl: string | null;
}

export interface ItCompletionMail {
  requesterName: string | null;
  /** The request's subject, answered as "Re: …". */
  requestSubject: string;
  employeeName: string;
  createdEmail: string;
  deletions: ItLeaverDone[];
  note?: string | null;
  completedByName: string;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const SUBJECT_CREATE = 'Request for New Email Account Creation';
const SUBJECT_BOTH =
  "Request for New Email Account Creation and Deletion of Terminated Employee's Email";

/**
 * DBL's subject line, with the new hire's name after it. Without the name,
 * every request would carry the same subject and Gmail would fold different
 * hires into one conversation in IT's inbox.
 */
export function itRequestSubject(m: {
  employeeName: string;
  deletions: readonly unknown[];
}): string {
  const base = m.deletions.length ? SUBJECT_BOTH : SUBJECT_CREATE;
  return `${base} — ${m.employeeName.trim()}`;
}

/** "This account will be used for official communication as …". */
export function defaultItPurpose(
  designation: string | null | undefined,
  department: string | null | undefined,
): string {
  const role = [designation?.trim(), department?.trim()]
    .filter(Boolean)
    .join(', ');
  return role
    ? `This account will be used for official communication as ${role}.`
    : 'This account will be used for official communication.';
}

/** 15 October 2026 — the date as Dhaka reads it. */
export function formatItDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Dhaka',
  }).format(d);
}

// --- blocks: one description, two renderings ------------------------------

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'fields'; rows: [string, string][] }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'signature'; lead: string; lines: string[] };

function renderText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'p':
      case 'heading':
        out.push(b.text);
        break;
      case 'fields':
        out.push(b.rows.map(([k, v]) => `${k}: ${v}`).join('\n'));
        break;
      case 'button':
        out.push(b.url);
        break;
      case 'signature':
        out.push(`${b.lead}\n\n${b.lines.join('\n')}`);
        break;
    }
  }
  return `${out.join('\n\n')}\n`;
}

const P = 'margin:0 0 14px';
function renderHtml(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'p':
        out.push(`<p style="${P}">${esc(b.text)}</p>`);
        break;
      case 'heading':
        out.push(
          `<p style="margin:22px 0 8px;font-weight:bold;color:#0f172a">${esc(b.text)}</p>`,
        );
        break;
      case 'fields':
        out.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px">${b.rows
            .map(
              ([k, v]) =>
                `<tr><td style="padding:2px 16px 2px 0;color:#64748b;white-space:nowrap;vertical-align:top">${esc(k)}:</td><td style="padding:2px 0;color:#0f172a;vertical-align:top">${esc(v)}</td></tr>`,
            )
            .join('')}</table>`,
        );
        break;
      case 'button':
        out.push(
          `<p style="margin:4px 0 6px"><a href="${esc(b.url)}" style="display:inline-block;background:#1877c0;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;font-size:14px">${esc(b.label)}</a></p>` +
            `<p style="margin:0 0 14px;font-size:12px;color:#64748b">Or open this link: <span style="color:#334155">${esc(b.url)}</span></p>`,
        );
        break;
      case 'signature':
        out.push(
          `<p style="margin:22px 0 10px">${esc(b.lead)}</p><p style="margin:0">${b.lines
            .map((l, i) => (i === 0 ? `<b>${esc(l)}</b>` : esc(l)))
            .join('<br>')}</p>`,
        );
        break;
    }
  }
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;max-width:640px">${out.join('\n')}</div>`;
}

// --- the request ------------------------------------------------------------

export function renderItRequest(m: ItRequestMail): RenderedMail {
  const both = m.deletions.length > 0;
  const blocks: Block[] = [];
  blocks.push({ kind: 'p', text: `Dear ${m.salutation.trim() || 'IT Team'},` });
  blocks.push({ kind: 'p', text: 'Hope you are doing well.' });

  const from = m.lineOfBusiness?.trim()
    ? `${m.unit} (${m.lineOfBusiness.trim()})`
    : m.unit;
  blocks.push({
    kind: 'p',
    text: both
      ? `Please find below two requests from ${from}.`
      : `Please find below a request from ${from}.`,
  });

  blocks.push({
    kind: 'heading',
    text: both ? '1. New Email Account Creation' : 'New Email Account Creation',
  });
  const rows: [string, string][] = [['Employee Name', m.employeeName.trim()]];
  if (m.employeeId?.trim()) rows.push(['Employee ID', m.employeeId.trim()]);
  if (m.designation?.trim()) rows.push(['Designation', m.designation.trim()]);
  if (m.department?.trim()) rows.push(['Department', m.department.trim()]);
  rows.push([
    'Preferred Email Address',
    m.preferredEmail?.trim() || 'To be assigned by IT',
  ]);
  rows.push(['New Employee', 'Yes']);
  rows.push(['Email Platform', m.platform.trim() || 'Google']);
  if (m.joiningDate) rows.push(['Joining Date', formatItDate(m.joiningDate)]);
  if (m.purpose?.trim()) rows.push(['Purpose', m.purpose.trim()]);
  blocks.push({ kind: 'fields', rows });

  if (both) {
    const many = m.deletions.length > 1;
    blocks.push({
      kind: 'heading',
      text: "2. Deletion of Terminated Employee's Email Account",
    });
    blocks.push({
      kind: 'p',
      text: many
        ? 'The following employees have left the company. Kindly delete their email accounts.'
        : 'The following employee has left the company. Kindly delete the email account.',
    });
    for (const d of m.deletions) {
      const r: [string, string][] = [['Employee Name', d.name.trim()]];
      if (d.code?.trim()) r.push(['Employee Code', d.code.trim()]);
      r.push(['Email Address', d.email.trim()]);
      if (d.reason?.trim()) r.push(['Reason for leaving', d.reason.trim()]);
      blocks.push({ kind: 'fields', rows: r });
    }
  }

  const ask = both
    ? 'Please confirm once both requests are completed'
    : 'Please confirm once the account is created';
  if (m.confirmUrl) {
    blocks.push({
      kind: 'p',
      text: `${ask}, using the button below. It records the new address in DBL HRM and lets HR know.`,
    });
    blocks.push({
      kind: 'button',
      label: 'Confirm completed',
      url: m.confirmUrl,
    });
  } else {
    blocks.push({
      kind: 'p',
      text: `${ask}. (The confirmation link is added when the request is sent.)`,
    });
  }

  const role = [m.requester.designation?.trim(), m.requester.department?.trim()]
    .filter(Boolean)
    .join(' | ');
  blocks.push({
    kind: 'signature',
    lead: 'Warm Regards,',
    lines: [
      m.requester.name.trim(),
      role ? `${role} | DBL Group` : 'DBL Group',
      ...(m.requester.phone?.trim()
        ? [`Mobile: ${m.requester.phone.trim()}`]
        : []),
    ],
  });

  return {
    subject: itRequestSubject(m),
    text: renderText(blocks),
    html: renderHtml(blocks),
  };
}

// --- the reply ---------------------------------------------------------------

export function renderItCompletion(m: ItCompletionMail): RenderedMail {
  const deleted = m.deletions.filter((d) => d.deleted);
  const kept = m.deletions.filter((d) => !d.deleted);
  const blocks: Block[] = [];

  const name = m.requesterName ? firstName(m.requesterName) : '';
  blocks.push({ kind: 'p', text: `Dear ${name || 'Colleague'},` });
  blocks.push({
    kind: 'p',
    text: !m.deletions.length
      ? 'The request has been completed successfully as per your request.'
      : !kept.length
        ? 'Both requests have been completed successfully as per your request.'
        : kept.length === m.deletions.length
          ? 'The new email account has been created as per your request. The account below was not deleted — please see the note.'
          : 'The new email account has been created as per your request. Not every account was deleted — please see below.',
  });

  blocks.push({ kind: 'heading', text: 'New Email Account Created' });
  blocks.push({
    kind: 'fields',
    rows: [
      ['Employee Name', m.employeeName.trim()],
      ['Email Address', m.createdEmail.trim()],
    ],
  });

  const leaverRows = (d: ItLeaver): [string, string][] => [
    ['Employee Name', d.name.trim()],
    ...(d.code?.trim()
      ? [['Employee Code', d.code.trim()] as [string, string]]
      : []),
    ['Email Address', d.email.trim()],
  ];
  if (deleted.length) {
    blocks.push({
      kind: 'heading',
      text:
        deleted.length > 1 ? 'Email Accounts Deleted' : 'Email Account Deleted',
    });
    for (const d of deleted)
      blocks.push({ kind: 'fields', rows: leaverRows(d) });
  }
  if (kept.length) {
    blocks.push({
      kind: 'heading',
      text:
        kept.length > 1
          ? 'Email Accounts Not Deleted'
          : 'Email Account Not Deleted',
    });
    for (const d of kept) blocks.push({ kind: 'fields', rows: leaverRows(d) });
  }
  if (m.note?.trim())
    blocks.push({ kind: 'p', text: `Note: ${m.note.trim()}` });

  blocks.push({
    kind: 'signature',
    lead: 'Thanks & Regards,',
    lines: [m.completedByName.trim()],
  });

  const subject = m.requestSubject.startsWith('Re: ')
    ? m.requestSubject
    : `Re: ${m.requestSubject}`;
  return { subject, text: renderText(blocks), html: renderHtml(blocks) };
}
