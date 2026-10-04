import { DBL_LETTERHEAD_FOOTER } from '../../onboarding/letterhead';
import { AUTOMATED_EMAIL_NOTICE, EMAIL_LOGO_CID } from './automated-notice';
import { EMAIL_LOGO_SIZE } from './email-logo';

/**
 * DBL Group's branded email: the logo, a white letter on a grey page, and the
 * automated-email notice underneath.
 *
 * A message is written once, as blocks, and rendered twice — HTML for every
 * client that shows it, plain text for the ones that will not — so the two
 * versions cannot say different things.
 *
 * Built for mail clients rather than browsers: tables for layout, every style
 * inline, no web fonts, no background images, a 600px column that collapses to
 * the screen on a phone. The logo travels with the message as an inline
 * attachment (`cid:`), so it shows even where remote images are blocked —
 * MailService attaches it whenever the HTML refers to it.
 *
 * Decorator-free so specs can import it.
 */

/** A run of text inside a paragraph. */
export type Inline = string | { strong: string };

export type EmailBlock =
  | { kind: 'paragraph'; content: string | Inline[] }
  | { kind: 'heading'; text: string }
  /** Label / value pairs. A row whose value is blank is left out. */
  | {
      kind: 'details';
      rows: ReadonlyArray<readonly [string, string | null | undefined]>;
    }
  | {
      kind: 'button';
      label: string;
      href: string;
      tone?: 'primary' | 'secondary';
    }
  /** A label with the address written out under it, as a link. */
  | { kind: 'link'; label: string; href: string }
  /** A numbered list. */
  | { kind: 'list'; items: string[] }
  | { kind: 'signoff'; lines: string[] };

export interface BrandedEmailInput {
  subject: string;
  /** The line an inbox shows beside the subject, before the mail is opened. */
  preheader: string;
  blocks: EmailBlock[];
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const FONT = "'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const INK = '#0f2a45';
const BODY = '#334155';
const MUTED = '#64748b';
const BRAND = '#1877c0';

export function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const inlines = (content: string | Inline[]): Inline[] =>
  typeof content === 'string' ? [content] : content;

const inlineHtml = (content: string | Inline[]) =>
  inlines(content)
    .map((part) =>
      typeof part === 'string'
        ? esc(part)
        : `<strong style="color:#0f172a;font-weight:700">${esc(part.strong)}</strong>`,
    )
    .join('');

const inlineText = (content: string | Inline[]) =>
  inlines(content)
    .map((part) => (typeof part === 'string' ? part : part.strong))
    .join('');

const filledRows = (
  rows: ReadonlyArray<readonly [string, string | null | undefined]>,
) =>
  rows
    .map(([label, value]) => [label, value?.trim() ?? ''] as const)
    .filter(([, value]) => value !== '');

function blockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BODY}">${inlineHtml(block.content).replace(/\n/g, '<br>')}</p>`;

    case 'heading':
      return `<h2 style="margin:30px 0 10px;font-family:${FONT};font-size:16px;line-height:1.4;font-weight:700;color:${INK}">${esc(block.text)}</h2>`;

    case 'details': {
      const rows = filledRows(block.rows)
        .map(
          ([label, value]) => `<tr>
            <td class="dbl-label" valign="top" width="38%" style="padding:6px 14px 6px 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED}">${esc(label)}</td>
            <td class="dbl-value" valign="top" style="padding:6px 0;font-family:${FONT};font-size:14px;line-height:1.5;font-weight:600;color:#0f172a">${esc(value)}</td>
          </tr>`,
        )
        .join('');
      if (!rows) return '';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;background:#f6f9fc;border:1px solid #e3e9f0;border-radius:10px">
        <tr><td style="padding:14px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
        </td></tr>
      </table>`;
    }

    case 'button': {
      const primary = block.tone !== 'secondary';
      const cell = primary
        ? `bgcolor="${BRAND}" style="border-radius:8px;background:${BRAND}"`
        : `bgcolor="#ffffff" style="border-radius:8px;background:#ffffff;border:1.5px solid ${BRAND}"`;
      return `<table role="presentation" class="dbl-btn" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px">
        <tr><td align="center" ${cell}>
          <a href="${esc(block.href)}" target="_blank" style="display:inline-block;padding:${primary ? '13px 28px' : '12px 26px'};font-family:${FONT};font-size:14px;font-weight:700;line-height:1.2;color:${primary ? '#ffffff' : BRAND};text-decoration:none;border-radius:8px">${esc(block.label)}</a>
        </td></tr>
      </table>`;
    }

    case 'link':
      return `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BODY}">${esc(block.label)}<br><a href="${esc(block.href)}" target="_blank" style="color:${BRAND};font-weight:600;text-decoration:none;word-break:break-all">${esc(block.href)}</a></p>`;

    case 'list': {
      if (!block.items.length) return '';
      const rows = block.items
        .map(
          (item, i) => `<tr>
            <td valign="top" width="30" style="padding:6px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED}">${i + 1}.</td>
            <td valign="top" style="padding:6px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:#0f172a">${esc(item)}</td>
          </tr>`,
        )
        .join('');
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid #e3e9f0;border-radius:10px">
        <tr><td style="padding:10px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
        </td></tr>
      </table>`;
    }

    case 'signoff': {
      const [first, ...rest] = block.lines;
      const lines = [
        esc(first ?? ''),
        ...rest.map((line, i) =>
          i === 0
            ? `<strong style="color:#0f172a;font-weight:700">${esc(line)}</strong>`
            : esc(line),
        ),
      ];
      return `<p style="margin:28px 0 0;font-family:${FONT};font-size:15px;line-height:1.65;color:${BODY}">${lines.join('<br>')}</p>`;
    }
  }
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return inlineText(block.content);
    case 'heading':
      return block.text;
    case 'details':
      return filledRows(block.rows)
        .map(([label, value]) => `${label}: ${value}`)
        .join('\n');
    case 'button':
      return `${block.label}: ${block.href}`;
    case 'link':
      return `${block.label}\n${block.href}`;
    case 'list':
      return block.items.map((item, i) => `${i + 1}. ${item}`).join('\n');
    case 'signoff':
      return block.lines.join('\n');
  }
}

/**
 * Inbox preview text, padded so the client does not run on into the body
 * ("Talent Acquisition Dear …") after it.
 */
function preheaderHtml(text: string): string {
  const filler = '&#847;&zwnj;&nbsp;'.repeat(60);
  return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#eef2f6">${esc(text)}${filler}</div>`;
}

export function renderBrandedEmail(input: BrandedEmailInput): RenderedEmail {
  const body = input.blocks.map(blockHtml).filter(Boolean).join('\n');
  const logoWidth = EMAIL_LOGO_SIZE.width / 2;
  const logoHeight = Math.round(EMAIL_LOGO_SIZE.height / 2);
  const office = DBL_LETTERHEAD_FOOTER.office.replace(
    /^Registered & Corporate Office:\s*/,
    '',
  );

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(input.subject)}</title>
<style>
  @media only screen and (max-width:620px) {
    .dbl-shell { width:100% !important; }
    .dbl-pad { padding-left:22px !important; padding-right:22px !important; }
    .dbl-btn, .dbl-btn td { width:100% !important; }
    .dbl-btn a { display:block !important; text-align:center !important; }
    .dbl-label { display:block !important; width:auto !important; padding:8px 0 0 !important; }
    .dbl-value { display:block !important; padding:2px 0 6px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
${preheaderHtml(input.preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2f6" style="background:#eef2f6">
<tr><td align="center" style="padding:32px 12px 28px">

  <table role="presentation" class="dbl-shell" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #dfe5ec;border-radius:14px">
    <tr><td class="dbl-pad" style="padding:30px 44px 6px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="middle">
            <img src="cid:${EMAIL_LOGO_CID}" width="${logoWidth}" height="${logoHeight}" alt="DBL Group" style="display:block;width:${logoWidth}px;height:${logoHeight}px;border:0;outline:none;text-decoration:none">
          </td>
          <td valign="middle" align="right" style="font-family:${FONT};font-size:11px;line-height:1.4;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${MUTED}">Talent Acquisition</td>
        </tr>
      </table>
    </td></tr>
    <tr><td class="dbl-pad" style="padding:26px 44px 40px">
${body}
    </td></tr>
  </table>

  <table role="presentation" class="dbl-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
    <tr><td style="padding:22px 28px 6px;text-align:center;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED}">${
      // A sentence to a line, rather than wherever the column runs out.
      esc(AUTOMATED_EMAIL_NOTICE).replace('. ', '.<br>')
    }</td></tr>
    <tr><td style="padding:4px 28px 0;text-align:center;font-family:${FONT};font-size:11px;line-height:1.6;color:#94a3b8">DBL Group &middot; ${esc(office)} &middot; <a href="https://www.dbl-group.com" target="_blank" style="color:#94a3b8;text-decoration:underline">www.dbl-group.com</a></td></tr>
  </table>

</td></tr>
</table>
</body>
</html>`;

  const text = [
    ...input.blocks.map(blockText).filter(Boolean),
    `—\n${AUTOMATED_EMAIL_NOTICE}`,
  ].join('\n\n');

  return { subject: input.subject, html, text };
}

/**
 * A plain message — what a recruiter typed — in the branded layout: one
 * paragraph per blank-line-separated block, the writer's own line breaks kept.
 */
export function renderPlainMessage(
  subject: string,
  message: string,
): RenderedEmail {
  const paragraphs = message
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  // "Dear Rahim," says nothing in an inbox list; the first real sentence does.
  const opening =
    paragraphs.find((p) => !/^(dear|hello|hi)\b/i.test(p)) ?? subject;
  return renderBrandedEmail({
    subject,
    preheader: opening.replace(/\s+/g, ' ').slice(0, 140),
    blocks: paragraphs.map((p) => ({ kind: 'paragraph', content: p })),
  });
}
