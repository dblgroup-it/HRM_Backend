import { formatInterviewSlot } from './interview-panel-email';

export interface CandidateInterviewEmailInput {
  candidateName: string;
  designation: string;
  scheduledAt: Date | null;
  mode: string;
  location: string | null;
  meetLink: string | null;
  recruiter?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null;
}

export interface CandidateInterviewEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildCandidateInterviewEmail(
  input: CandidateInterviewEmailInput,
): CandidateInterviewEmail {
  const slot = formatInterviewSlot(input.scheduledAt);
  const details = interviewDetails(input);
  const contactName = clean(input.recruiter?.name) ?? 'Corporate HR';
  const contactPhone = clean(input.recruiter?.phone) ?? 'N/A';
  const contactEmail =
    clean(input.recruiter?.email) ??
    clean(process.env.MAIL_FROM) ??
    clean(process.env.MAIL_USER) ??
    'N/A';

  const subject = `Interview Invitation - ${input.designation} | DBL Group`;
  const mapText = details.mapsUrl
    ? `View Location & Directions - ${details.mapsUrl}`
    : 'Not applicable';

  const text = [
    `Dear ${input.candidateName},`,
    '',
    'Greetings from DBL Group.',
    '',
    `We are pleased to inform you that you have been shortlisted for an interview for the position of ${input.designation}. We would like to invite you to attend the interview as per the following schedule:`,
    '',
    'Interview Details',
    `Position: ${input.designation}`,
    `Date: ${slot?.date ?? 'To be confirmed'}`,
    `Time: ${slot?.time ?? 'To be confirmed'}`,
    `Venue: ${details.venueName}`,
    `Address: ${details.address}`,
    `Google Maps: ${mapText}`,
    '',
    'You are requested to arrive at the venue 10 minutes prior to the scheduled interview time and carry a copy of your updated CV and any relevant documents, if applicable.',
    '',
    'Should you require any assistance regarding the interview or venue, please feel free to contact:',
    contactName,
    'Corporate HR | DBL Group',
    `Contact: ${contactPhone}`,
    `Email: ${contactEmail}`,
    '',
    'We look forward to meeting you and discussing your professional experience and suitability for the position.',
    '',
    'Thank you for your interest in DBL Group.',
    '',
    'Sincerely,',
    'Corporate HR',
    'DBL Group',
  ].join('\n');

  const maps = details.mapsUrl
    ? `<a href="${attr(details.mapsUrl)}" style="color:#1877c0;text-decoration:none;font-weight:600">View Location &amp; Directions</a>`
    : 'Not applicable';

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#1a202c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e9eef4">
  <tr><td style="background:#1877c0;height:4px;font-size:0;line-height:0">&nbsp;</td></tr>
  <tr><td style="padding:28px">
    <p style="margin:0 0 18px;font-size:15px;color:#1a202c">Dear <strong>${esc(input.candidateName)}</strong>,</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#334155">Greetings from DBL Group.</p>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.7;color:#334155">
      We are pleased to inform you that you have been shortlisted for an interview for the position of <strong>${esc(input.designation)}</strong>. We would like to invite you to attend the interview as per the following schedule:
    </p>

    <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#1877c0">Interview Details</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:22px">
      ${detailRow('Position', input.designation)}
      ${detailRow('Date', slot?.date ?? 'To be confirmed')}
      ${detailRow('Time', slot?.time ?? 'To be confirmed')}
      ${detailRow('Venue', details.venueName)}
      ${detailRow('Address', details.address)}
      ${detailRowHtml('Google Maps', maps)}
    </table>

    <p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#334155">
      You are requested to arrive at the venue 10 minutes prior to the scheduled interview time and carry a copy of your updated CV and any relevant documents, if applicable.
    </p>
    <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#334155">
      Should you require any assistance regarding the interview or venue, please feel free to contact:
    </p>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">
      <strong>${esc(contactName)}</strong><br>
      Corporate HR | DBL Group<br>
      Contact: ${esc(contactPhone)}<br>
      Email: ${esc(contactEmail)}
    </p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#334155">
      We look forward to meeting you and discussing your professional experience and suitability for the position.
    </p>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.7;color:#334155">Thank you for your interest in DBL Group.</p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#334155">Sincerely,<br><strong>Corporate HR</strong><br>DBL Group</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}

function interviewDetails(input: CandidateInterviewEmailInput): {
  venueName: string;
  address: string;
  mapsUrl: string | null;
} {
  const meet = clean(input.meetLink) ?? clean(input.location);
  if (input.mode === 'ONLINE' || (meet && isUrl(meet))) {
    return {
      venueName: 'Online Interview',
      address: meet ?? 'Meeting link to be shared',
      mapsUrl: null,
    };
  }

  const location = clean(input.location) ?? 'To be confirmed';
  const room = splitVenue(location);
  return {
    venueName: room.venueName,
    address: room.address,
    mapsUrl:
      location === 'To be confirmed'
        ? null
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`,
  };
}

function splitVenue(location: string): { venueName: string; address: string } {
  if (location.includes(' :: ')) {
    const [building, room] = location.split(' :: ', 2).map((s) => s.trim());
    return { venueName: room || location, address: building || location };
  }
  const comma = location.indexOf(',');
  if (comma > 0 && comma < location.length - 1) {
    return {
      venueName: location.slice(0, comma).trim(),
      address: location.slice(comma + 1).trim(),
    };
  }
  return { venueName: location, address: location };
}

function detailRow(label: string, value: string): string {
  return detailRowHtml(label, esc(value));
}

function detailRowHtml(label: string, value: string): string {
  return `<tr>
    <td style="width:130px;padding:8px 12px;border:1px solid #e9eef4;background:#f8fafc;font-size:13px;font-weight:700;color:#475569">${esc(label)}</td>
    <td style="padding:8px 12px;border:1px solid #e9eef4;font-size:13px;color:#1e293b">${value}</td>
  </tr>`;
}

function clean(value?: string | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(url: string): string {
  return isUrl(url) ? esc(url.trim()) : '#';
}
