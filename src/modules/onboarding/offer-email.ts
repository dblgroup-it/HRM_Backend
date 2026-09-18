import type { LetterInput } from './letters';

/**
 * The covering note the offer letter travels with.
 *
 * The letter itself is now a PDF attachment — a letter is a document, and a
 * document belongs on the pad, not pasted into a mail body where every client
 * re-flows it differently. This is the short message that carries it, in the
 * wording Corporate HR uses.
 */

/** Surname only, the way DBL's letters address the reader ("Dear Mr. Ahmed"). */
function lastName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : full.trim();
}

/** "September 1, 2026" — the way the joining date is written in the letter. */
function fmtDate(d?: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

const esc = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface OfferEmail {
  subject: string;
  /** Paragraphs, in order — the same content for the text and HTML bodies. */
  paragraphs: string[];
  signOff: string[];
}

export function buildOfferEmail(input: LetterInput): OfferEmail {
  const greeting = input.salutation?.trim()
    ? `Dear ${input.salutation.trim()} ${lastName(input.candidateName)},`
    : `Dear ${input.candidateName.trim()},`;

  const post = input.department?.trim()
    ? `${input.designation} – ${input.department.trim()}`
    : input.designation;

  // Each sentence is dropped rather than left with a blank in it: a letter
  // that says "join on or before ." reads as a mistake by the sender.
  const selection = [
    `This is with reference to your application and subsequent interviews; we are pleased to inform you that you have been selected in our company for the position of ${post}.`,
    input.jobLocation?.trim()
      ? `Your Job location will be at ${input.jobLocation.trim()}.`
      : null,
    'A detailed appointment letter will be issued to you on your joining day.',
    fmtDate(input.joiningDate)
      ? `You have agreed to join the duties on or before ${fmtDate(input.joiningDate)}.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    subject: `Offer of employment — ${input.designation} | DBL Group`,
    paragraphs: [
      greeting,
      'Congratulations!',
      selection,
      'You are requested to return the duplicate copy of the offer of appointment signed by you in token of your acceptance or Email back to us using your personal email address to our official id tendering your consent.',
      'We welcome you onboard and wish a long association with you and a successful career ahead.',
    ],
    signOff: ['On Behalf of DBL Group', 'Corporate HR Department', 'DBL Group'],
  };
}

/** Plain-text body, for clients that will not render the HTML one. */
export function offerEmailText(email: OfferEmail, link: string): string {
  return [
    ...email.paragraphs,
    `You can also accept or decline online: ${link}`,
    // The sign-off is one block, not three paragraphs.
    email.signOff.join('\n'),
  ].join('\n\n');
}

/** HTML body — the same words, plus the portal buttons. */
export function offerEmailHtml(email: OfferEmail, link: string): string {
  const P = 'margin:0 0 14px;font-size:14px;line-height:1.6;color:#0f172a';
  const body = email.paragraphs
    .map((p) => `<p style="${P}">${esc(p)}</p>`)
    .join('\n  ');
  const sign = email.signOff.map((l) => esc(l)).join('<br>');
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:28px 32px">
  ${body}
  <p style="${P};margin-top:22px">${sign}</p>
  <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e2e8f0">
    <p style="margin:0 0 12px;font-size:13px;color:#475569">Your offer letter is attached as a PDF. You can also respond online:</p>
    <a href="${link}" style="display:inline-block;background:#1877c0;color:#fff;font-size:14px;font-weight:700;text-decoration:none;padding:11px 26px;border-radius:6px">Accept offer &amp; submit documents</a>
    <div style="margin-top:12px;font-size:13px">
      <a href="${link}?action=decline" style="color:#b91c1c;text-decoration:underline">I need to decline this offer</a>
    </div>
  </div>
  </div>
</body></html>`;
}
