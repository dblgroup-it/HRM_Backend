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

/** A run of body text; `bold` is what Corporate HR emphasises by hand. */
export interface Span {
  text: string;
  bold?: boolean;
}

export interface OfferEmail {
  subject: string;
  /** Paragraphs, in order, as runs — so the HTML body can bold the details. */
  paragraphs: Span[][];
  signOff: string[];
}

/**
 * @param senderName who is sending it — their name sits in the sign-off, the
 *   way Corporate HR signs these. Omitted when unknown rather than left as a
 *   blank line.
 */
export function buildOfferEmail(
  input: LetterInput,
  senderName?: string | null,
): OfferEmail {
  const greeting = input.salutation?.trim()
    ? `Dear ${input.salutation.trim()} ${lastName(input.candidateName)},`
    : `Dear ${input.candidateName.trim()},`;

  const post = input.department?.trim()
    ? `${input.designation} – ${input.department.trim()}`
    : input.designation;

  const joining = fmtDate(input.joiningDate);
  // A sentence whose value is missing is dropped rather than left with a gap
  // in it: "join the duties on or before ." reads as a mistake by the sender.
  const selection: Span[] = [
    {
      text: 'This is with reference to your application and subsequent interviews; we are pleased to inform you that you have been selected in our company for the position of ',
    },
    { text: `${post}.`, bold: true },
  ];
  if (input.jobLocation?.trim()) {
    selection.push(
      { text: ' Your Job location will be at ' },
      { text: `${input.jobLocation.trim()}.`, bold: true },
    );
  }
  selection.push({
    text: ' A detailed appointment letter will be issued to you on your joining day.',
  });
  if (joining) {
    selection.push(
      { text: ' You have agreed to join the duties on or before ' },
      { text: joining, bold: true },
    );
  }

  return {
    // "Offer Letter, Deputy General Manager - Washing (Hamza Textiles Ltd.)",
    // following the subject line Corporate HR already uses. The unit is spelled
    // out rather than abbreviated: DBL's own shorthand is not derivable from
    // the name, and a wrong abbreviation on an offer is worse than a long one.
    subject: `Offer Letter, ${input.designation}${
      input.department?.trim() ? ` - ${input.department.trim()}` : ''
    } (${input.unitFactory.replace(/\.+$/, '')})`,
    paragraphs: [
      [{ text: greeting }],
      [{ text: 'Congratulations!' }],
      selection,
      [
        {
          text: 'You are requested to return the duplicate copy of the offer of appointment signed by you in token of your acceptance or Email back to us using your personal email address to our official id tendering your consent.',
        },
      ],
      [
        {
          text: 'We welcome you onboard and wish a long association with you and a successful career ahead.',
        },
      ],
    ],
    signOff: [
      'On Behalf of DBL Group',
      ...(senderName?.trim() ? [senderName.trim()] : []),
      'Corporate HR Department',
      'DBL Group',
    ],
  };
}

/** One paragraph as plain words. */
const plain = (spans: Span[]) => spans.map((s) => s.text).join('');

/** Plain-text body, for clients that will not render the HTML one. */
export function offerEmailText(email: OfferEmail, link: string): string {
  return [
    ...email.paragraphs.map(plain),
    `You can also accept or decline online: ${link}`,
    // The sign-off is one block, not several paragraphs.
    email.signOff.join('\n'),
  ].join('\n\n');
}

/** HTML body — the same words, plus the portal buttons. */
/**
 * The HTML body — a plain message, not a designed card.
 *
 * This is a letter from one person to another, read next to everything else in
 * the candidate's inbox. Panels, brand bars and rounded borders would make it
 * look like a mailshot. The details are emphasised in bold, the way Corporate
 * HR writes them.
 */
export function offerEmailHtml(email: OfferEmail, link: string): string {
  const P = 'margin:0 0 14px;font-size:14px;line-height:1.55;color:#202124';
  const body = email.paragraphs
    .map(
      (spans) =>
        `<p style="${P}">${spans
          .map((s) => (s.bold ? `<b>${esc(s.text)}</b>` : esc(s.text)))
          .join('')}</p>`,
    )
    .join('\n  ');
  const sign = email.signOff.map((l) => esc(l)).join('<br>');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#fff;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:720px;padding:16px 4px">
  ${body}
  <p style="${P};margin-top:20px;color:#1155cc">${sign}</p>
  <p style="margin:22px 0 0;font-size:13px;color:#5f6368">
    Your offer letter is attached. You can also
    <a href="${link}" style="color:#1155cc">accept it online</a>,
    or <a href="${link}?action=decline" style="color:#b91c1c">let us know you need to decline</a>.
  </p>
  </div>
</body></html>`;
}
