import { DBL_LOGO_DATA_URI } from './letterhead';

/**
 * DBL's "Acknowledgement of Company Code of Conduct" form.
 *
 * Transcribed from the paper original. It is sent to a selected candidate to
 * sign before joining, and the same builder produces both states: the blank
 * form, and the completed one carrying the candidate's name and signature.
 *
 * The office-use block stays on the signed copy. HR counter-signs it on paper
 * when they file it, exactly as they do today — this system does not pretend
 * to have captured that signature.
 */

export interface CocInput {
  employeeName: string;
  /** Blank until they have one: a candidate has no employee ID before joining. */
  employeeId?: string | null;
  /** Data URI of the signature image, when signed. */
  signatureDataUri?: string | null;
  signedAt?: Date | null;
}

const esc = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtDate = (d?: Date | null) =>
  d
    ? d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '';

const P =
  'margin:0 0 11px;font-size:10.5pt;line-height:1.5;text-align:justify;color:#000';

/** The ZingHR trail a reader follows to find the policy itself. */
const CRUMBS = [
  'ZingHR My Home',
  'More Links',
  'HR Handbook',
  'Policies',
  'Code of Conduct',
];

function crumbs(): string {
  const box = (label: string) =>
    `<td style="border:1px solid #9aa4b2;border-radius:3px;padding:6px 10px;font-size:8.5pt;white-space:nowrap">${esc(label)}</td>`;
  const arrow =
    '<td style="padding:0 6px;color:#9aa4b2;font-size:11pt">&#10142;</td>';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 16px">
    <tr>${CRUMBS.map(box).join(arrow)}</tr>
  </table>`;
}

/** A labelled field with a rule under it, the way the paper form sets them. */
function field(label: string, value: string, width: string): string {
  return `<td style="width:${width};padding:0 10px 0 0;vertical-align:bottom">
    <div style="min-height:20px;font-size:10.5pt;padding:0 2px 3px">${value}</div>
    <div style="border-top:1px solid #000;padding-top:3px;font-size:9pt;font-weight:700">${esc(label)}</div>
  </td>`;
}

export function buildCocForm(input: CocInput): string {
  const name = esc(input.employeeName ?? '');
  const signed = Boolean(input.signedAt);
  const signature = input.signatureDataUri
    ? `<img src="${input.signatureDataUri}" alt="" style="height:34px;width:auto;display:block;margin-bottom:2px">`
    : '';

  return `
<div class="dbl-coc" style="font-family:Calibri,'Segoe UI',Arial,sans-serif;color:#000;max-width:780px;margin:0 auto;padding:26px 34px;background:#fff">
  <style>
    @media print { .dbl-coc { max-width: none !important; padding: 0 !important } }
  </style>
  <div class="dbl-pad-head" style="padding:0 0 6px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="width:110px;vertical-align:middle">
          <img src="${DBL_LOGO_DATA_URI}" alt="DBL Group" style="height:44px;width:auto;display:block">
        </td>
        <td style="vertical-align:middle;text-align:center;font-size:16pt;line-height:1.35">
          Acknowledgement of<br>Company Code of Conduct (CoC)
        </td>
        <td style="width:110px"></td>
      </tr>
    </table>
    <div style="border-bottom:1px solid #9aa4b2;margin-top:10px"></div>
  </div>

  <p style="${P};margin-top:16px">
    I, <span style="display:inline-block;min-width:260px;border-bottom:1px solid #000;text-align:center;font-weight:${signed ? '700' : '400'}">${name}</span>
    acknowledge that I have received, read, and understood the DBL Group Code of
    Conduct. I agree to adhere to the guidelines and standards of behavior
    outlined in the Code of Conduct. I understand that my commitment to these
    principles is crucial in maintaining the integrity, fairness, and respect
    that DBL Group stands for.
  </p>

  <p style="${P}">
    I recognize that any violation of the Code of Conduct may result in
    disciplinary action, up to and including termination of employment. I am
    aware that I am expected to report any potential violations of the Code of
    Conduct to my supervisor, the Human Resources department, or through any
    designated reporting channels provided by the company.
  </p>

  <p style="${P}">
    I also understand that DBL Group reserves the right to amend, modify, or
    update the Code of Conduct as necessary and that I will be notified of such
    changes. I acknowledge that my continued employment will indicate my
    acceptance of these updated provisions.
  </p>

  <p style="${P};font-weight:700">
    I have read and agree to follow the instructions and Company Code of Conduct
    Policy attached in ZingHR (HR Handbook Section).
  </p>

  <p style="${P};margin-bottom:0">
    Link:
    <a href="https://zingnext.zinghr.com/portal" style="color:#1155cc">https://zingnext.zinghr.com/portal</a>
  </p>
  ${crumbs()}

  <p style="${P}">
    By signing below, I confirm my agreement to comply with the DBL Group Code
    of Conduct.
  </p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #9aa4b2;margin:0 0 26px">
    <tr>
      <td style="width:150px;border-right:1px solid #9aa4b2;padding:6px 8px;font-size:10pt;font-weight:700">Employee Name</td>
      <td style="border-right:1px solid #9aa4b2;padding:6px 8px;font-size:10.5pt">${name}</td>
      <td style="width:110px;border-right:1px solid #9aa4b2;padding:6px 8px;font-size:10pt;font-weight:700">Employee ID</td>
      <td style="padding:6px 8px;font-size:10.5pt">${esc(input.employeeId ?? '')}</td>
    </tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
    <tr>
      ${field('Employee Signature', signature, '55%')}
      ${field('Date', esc(fmtDate(input.signedAt)), '45%')}
    </tr>
  </table>

  <div style="border-top:1px dashed #9aa4b2;margin:18px 0 12px"></div>
  <p style="margin:0 0 14px;text-align:center;font-size:11pt;font-weight:700">For Office Use Only</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #9aa4b2;margin:0 0 26px">
    <tr>
      <td style="width:190px;border-right:1px solid #9aa4b2;padding:6px 8px;font-size:10pt;font-weight:700">HR Representative Name</td>
      <td style="border-right:1px solid #9aa4b2;padding:6px 8px">&nbsp;</td>
      <td style="width:110px;border-right:1px solid #9aa4b2;padding:6px 8px;font-size:10pt;font-weight:700">Employee ID</td>
      <td style="padding:6px 8px">&nbsp;</td>
    </tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${field('HR Representative Signature', '', '55%')}
      ${field('Date', '', '45%')}
    </tr>
  </table>
</div>`;
}
