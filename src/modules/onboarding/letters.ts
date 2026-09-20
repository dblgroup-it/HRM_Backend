import { DBL_LETTERHEAD_FOOTER, DBL_LOGO_DATA_URI } from './letterhead';

/**
 * DBL's offer and appointment letters.
 *
 * Two house formats, transcribed from the signed originals:
 *
 *  - `junior`  — prose. Probation period and notice, and it points forward to
 *                a Service Agreement letter given after joining.
 *  - `senior`  — numbered terms. Job location and a benefits list (festival
 *                bonuses, LFA, car), and it points forward to an Appointment
 *                letter instead.
 *
 * The wording is the client's, not ours: these go out over the CHRO's
 * signature, so the templates stay literal and the variable parts are the only
 * thing the system fills in.
 */

export type LetterFormat = 'junior' | 'senior';

export const LETTER_FORMATS: {
  value: LetterFormat;
  label: string;
  hint: string;
}[] = [
  {
    value: 'junior',
    label: 'Junior / Mid',
    hint: 'Job location, probation and notice. Points to a Service Agreement after joining.',
  },
  {
    value: 'senior',
    label: 'Senior',
    hint: 'Numbered terms with job location and benefits. Points to an Appointment letter.',
  },
];

/** Benefits offered on the senior format unless HR edits them. */
export const DEFAULT_SENIOR_BENEFITS = [
  'Two Festival Bonuses in a year as per company policy;',
  'Leave Fair Assistance (LFA) will be entitled as per company policy;',
  'Full time car as per company policy;',
  'Other admissible benefits as per company policy;',
];

/** Documents the candidate brings on joining — the junior letter's longer list. */
const JUNIOR_DOCUMENTS = [
  'Four passport size photographs in formals with white background. [A soft copy of Photograph with 600*600 size]',
  'All relevant education certificate and marks sheet (High School onward)',
  'Experience certificate (s)',
  'Relieving letter and last pay slip from the previous employer',
  'Copy of National ID / Birth Registration / Passport (At least one)',
  'Copy of residence proof (any govt. bill)',
  'Copy of TIN/Last Tax return Submission (if any)',
];

const SENIOR_DOCUMENTS = [
  'Four passport size photographs in formals with white background',
  'All educational certificates',
  'Experience certificate(s)',
  'Relieving letter and last pay slip from the previous employer (If required)',
  'Copy of National ID / Birth Registration / Passport',
  'Copy of TIN/Last Tax return Submission (if any)',
];

export interface LetterInput {
  candidateName: string;
  /** "Mr." / "Ms." — left off when unknown rather than guessed. */
  salutation?: string | null;
  address?: string | null;
  designation: string;
  /**
   * The department the post sits in — "Admin, Safety & Security".
   *
   * Printed after the designation, because a designation alone is ambiguous in
   * a group this size: an Additional General Manager could be running Admin,
   * Finance or Production, and the letter is the document that settles which.
   */
  department?: string | null;
  unitFactory: string;
  reference?: string | null;
  date?: Date | null;
  joiningDate?: Date | null;
  jobLocation?: string | null;
  probationMonths?: number | null;
  noticeDays?: number | null;
  benefits?: string[];
  signatoryName: string;
  signatoryTitle: string;
  /**
   * The signatory's e-signature as a data URI, when they have one on file.
   *
   * Inlined rather than linked because the letter is stored, emailed and
   * printed to PDF: a URL would be an image the recipient's mail client
   * cannot fetch and the archived copy would lose. Null simply leaves the
   * ruled line blank for a wet signature, which is how these went out before.
   */
  signatorySignature?: string | null;
  /**
   * The candidate's own e-signature, and the date they gave.
   *
   * Set only when rendering the counter-signed copy at the moment they accept
   * online; a letter going *out* leaves both blank for them to fill in.
   */
  candidateSignature?: string | null;
  candidateAcceptedDate?: Date | null;
}

/**
 * Where the candidate's half of the letter goes.
 *
 * The letter is stored exactly as it was sent and must stay that way, so when
 * they accept online we render a *copy* with their signature and date filled
 * in. That fill needs somewhere to aim at: these two markers are it, and
 * `applyCandidateAcceptance` in accepted-offer.ts rewrites what is between
 * them. Anything else would mean pattern-matching a row of underscores in
 * stored HTML, which breaks the first time the template is reworded.
 */
export const ACCEPT_SIGN_MARKER = 'dbl-accept-sign';
export const ACCEPT_DATE_MARKER = 'dbl-accept-date';

/** The blank a candidate signing on paper writes their joining date on. */
export const ACCEPT_DATE_BLANK = '______________________';

/**
 * A signature image sitting on the ruled line, or nothing.
 *
 * Fixed height so one person's 900x300 crop and another's phone photo print
 * at the same size, and `margin-bottom:-2px` so the ink meets the rule rather
 * than floating above it.
 */
export function signatureInk(dataUri?: string | null): string {
  if (!dataUri) return '';
  return `<img src="${dataUri}" alt="" style="height:44px;width:auto;max-width:220px;display:block;margin-bottom:-2px">`;
}

/** The candidate's signature slot — empty on a letter going out. */
function candidateSignSlot(input: LetterInput): string {
  return `<span class="${ACCEPT_SIGN_MARKER}">${signatureInk(input.candidateSignature)}</span>`;
}

/** The joining date they gave, or the blank rule they write it on. */
function candidateDateSlot(input: LetterInput): string {
  const when = input.candidateAcceptedDate;
  const filled = when
    ? `<strong>${esc(fmtJoining(when))}</strong>`
    : ACCEPT_DATE_BLANK;
  return `<span class="${ACCEPT_DATE_MARKER}">${filled}</span>`;
}

/** The letterhead date — "September 5, 2026". */
const fmtDate = (d?: Date | null) =>
  d
    ? d.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

/**
 * The joining date inside the body — "15 September 2026".
 *
 * Deliberately a different format from the letterhead date above: that is how
 * the signed originals read, and these go out over the CHRO's signature.
 */
const fmtJoining = (d?: Date | null) =>
  d
    ? d.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';

const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * How the letters name the post: designation, then department.
 *
 *   "Additional General Manager - Admin, Safety & Security"
 *
 * Joined with a spaced hyphen to match the signed originals. The department is
 * skipped when it is missing, and when the designation already contains it —
 * some designations are recorded with the department baked in, and "Manager -
 * Admin - Admin" on an appointment letter is the kind of thing that has to be
 * reprinted and re-signed.
 */
function positionTitle(
  designation: string,
  department?: string | null,
): string {
  const role = designation.trim();
  const dept = (department ?? '').trim();
  if (!dept) return role;
  if (role.toLowerCase().includes(dept.toLowerCase())) return role;
  return `${role} - ${dept}`;
}

/**
 * A unit name at the end of a sentence.
 *
 * Several unit names already end in a period ("DBL Telecom Ltd."), which made
 * the closing line read "team member of DBL Telecom Ltd..".
 */
const unitSentenceEnd = (name: string) => esc(name.replace(/\.+$/, '')) + '.';

/** Surname only, the way the letters address the reader ("Dear Mr. Alam,"). */
function lastName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : full;
}

const P = 'margin:0 0 12px;font-size:11pt;line-height:1.5;text-align:justify';
const LI = 'margin:0 0 4px;font-size:11pt;line-height:1.45';

/**
 * The letter, on DBL's printed pad.
 *
 * On screen — and when HR prints a copy from the browser — the logo and
 * address block sit in the flow, so the review modal shows what the candidate
 * will receive. The PDF renderer strips these two blocks and draws the pad
 * into each page's margin instead, which is how it repeats on every sheet of a
 * letter that runs to two pages.
 */
function shell(body: string): string {
  return `
<div class="dbl-letter" style="font-family:Calibri,'Segoe UI',Arial,sans-serif;color:#000;max-width:760px;margin:0 auto;padding:28px 34px;background:#fff;position:relative">
  <style>
    .dbl-letter .dbl-pad-head { padding: 0 0 18px }
    .dbl-letter .dbl-pad-foot {
      margin-top: 26px; padding-top: 8px; border-top: 1px solid #1f3864;
      text-align: center; font-size: 8.5pt; line-height: 1.45; color: #1f3864;
    }
    /* Printing from the browser keeps the pad in flow — that path has no page
       margins to draw it into, and HR printing a copy should still get a
       letterhead. The PDF renderer removes these two blocks instead, because
       there the pad is drawn into every page's margin (see PdfService). */
    @media print {
      /* !important because the wrapper carries its own inline style, which an
         email client cannot be trusted to read from a stylesheet — and an
         inline style outranks any rule here without it. In print the page
         margin already provides the gutter, so the letter itself takes none:
         that is what lines the text up with the letterhead above it. */
      .dbl-letter { max-width: none !important; padding: 0 !important }
    }
  </style>
  <div class="dbl-pad-head">
    <img src="${DBL_LOGO_DATA_URI}" alt="DBL Group" style="height:56px;width:auto;display:block">
  </div>
${body}
  <div class="dbl-pad-foot">
    ${DBL_LETTERHEAD_FOOTER.office}<br>${DBL_LETTERHEAD_FOOTER.contact}
  </div>
</div>`;
}

function head(input: LetterInput, showDate: boolean): string {
  // Escaped like every other interpolated value: this lands in HTML that is
  // rendered with dangerouslySetInnerHTML in the review modal and emailed out.
  const title = input.salutation?.trim()
    ? `${esc(input.salutation.trim())} `
    : '';
  return `
  <p style="${P}">
    Date: ${fmtDate(input.date ?? new Date())}${showDate ? '' : ''}<br>
    Ref: ${esc(input.reference ?? '')}
  </p>

  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:11pt;margin:0 0 14px">
    <tr>
      <td style="padding:0 0 2px;font-weight:700;width:110px">Name</td>
      <td style="padding:0 0 2px;font-weight:700">: ${title}${esc(input.candidateName)}</td>
    </tr>
    <tr>
      <td style="padding:0;font-weight:700">Address</td>
      <td style="padding:0">: ${esc(input.address ?? '')}</td>
    </tr>
  </table>

  <p style="text-align:center;margin:0 0 16px">
    <span style="font-weight:700;text-decoration:underline;font-size:12pt">Offer Letter</span>
  </p>

  <p style="${P};font-weight:700">Dear ${title}${esc(lastName(input.candidateName))},</p>`;
}

function signatures(input: LetterInput): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px;font-size:11pt">
    <tr>
      <td style="width:50%;vertical-align:top"></td>
      <td style="width:50%;vertical-align:top;line-height:1.5">
        I agree with the terms &amp; conditions and<br>
        hereby accept the employment offer. My<br>
        Expected date of join ${candidateDateSlot(input)}
      </td>
    </tr>
    <tr>
      <td style="padding-top:4px">Yours sincerely,</td>
      <td></td>
    </tr>
    <tr>
      <td style="padding-top:12px">
        <div style="height:44px">${signatureInk(input.signatorySignature)}</div>
        <div style="border-top:1px solid #000;width:230px"></div>
        <div style="font-weight:700;margin-top:4px">${esc(input.signatoryName)}</div>
        <div>${esc(input.signatoryTitle)}</div>
      </td>
      <td style="padding-top:12px">
        <div style="height:44px">${candidateSignSlot(input)}</div>
        <div style="border-top:1px solid #000;width:270px"></div>
        <div style="font-weight:700;margin-top:4px;text-align:center;width:270px">${esc(input.candidateName)}</div>
      </td>
    </tr>
  </table>`;
}

/** The prose format — probation, notice, Service Agreement to follow. */
/**
 * The job-location sentence, or nothing.
 *
 * Never falls back to the unit. The unit is who employs the person; the job
 * location is where they work, and at DBL those are routinely different
 * addresses — printing the unit name here would state something untrue on a
 * letter the candidate signs. If HR has not chosen a location, the sentence
 * is simply left out.
 */
function jobLocationLine(input: LetterInput): string {
  const where = input.jobLocation?.trim();
  if (!where) return '';
  // Several of the stored addresses already end in a full stop; the sentence
  // supplies its own, and "Bangladesh.." on a signed letter looks careless.
  return `<p style="${P}">
    Your job location will be at <strong>${esc(where.replace(/\.+$/, ''))}</strong>.
  </p>`;
}

function juniorOffer(input: LetterInput): string {
  const months = input.probationMonths ?? 6;
  const notice = input.noticeDays ?? 15;
  const docs = JUNIOR_DOCUMENTS.map(
    (d) => `<li style="${LI}">${esc(d)}</li>`,
  ).join('');

  return shell(`
${head(input, true)}

  <p style="${P}">
    This is with reference to your application and the subsequent interviews you had with us.
    We are pleased to offer you the position of
    <strong>${esc(positionTitle(input.designation, input.department))}</strong> in
    <strong>${esc(input.unitFactory)}</strong> with the following terms &amp; condition.
    Your service starting date in the organization shall be effective on or before
    <strong>${fmtJoining(input.joiningDate)}.</strong>
  </p>

  ${jobLocationLine(input)}

  <p style="${P}">
    This offer is valid subject to satisfactory pre-employment medical fitness and shall be
    nullified in case of any deviation in the information provided by you earlier. If any
    document provided by you is identified as false afterwards, shall also be nullified your
    services in the Company.
  </p>

  <p style="${P}">
    Please return a copy of this letter duly signed by you as token of your acceptance of the offer.
  </p>

  <p style="${P}">
    You should be placed on a probation period of ${String(months).padStart(2, '0')} (${numberWord(months)}) months' as per
    the company policy from your date of joining the organization. ${notice} days' notice to be
    given to the employer for separation of the employment during this period, whatsoever reason.
  </p>

  <p style="${P}">
    You are requested to submit copies of the following documents and bring along the originals
    (for verification) on your date of joining:
  </p>

  <ul style="margin:0 0 12px;padding-left:22px">${docs}</ul>

  <p style="${P}">
    All other terms and conditions of service will be explained in detail in the Service Agreement
    letter which will be given to you after joining.
  </p>

  <p style="${P}">
    Looking forward to welcome you and seeing yourself as a team member of ${unitSentenceEnd(input.unitFactory)}
  </p>

${signatures(input)}`);
}

/** The numbered format — job location, benefits, Appointment letter to follow. */
function seniorOffer(input: LetterInput): string {
  const benefits = (
    input.benefits?.length ? input.benefits : DEFAULT_SENIOR_BENEFITS
  )
    .map((b) => `<li style="${LI}">${esc(b)}</li>`)
    .join('');
  const docs = SENIOR_DOCUMENTS.map(
    (d) => `<li style="${LI}">${esc(d)}</li>`,
  ).join('');
  const num =
    'margin:0 0 10px;font-size:11pt;line-height:1.5;text-align:justify';

  return shell(`
${head(input, true)}

  <p style="${P}">
    This is with reference to your application and the subsequent interviews you had with us.
    The management is pleased to offer you for the position of
    <strong>"${esc(positionTitle(input.designation, input.department))}"</strong> of
    <strong>${esc(input.unitFactory)}</strong>
    under the following terms &amp; conditions:
  </p>

  <ol style="margin:0 0 12px;padding-left:22px">
    ${
      input.jobLocation?.trim()
        ? `<li style="${num}">
      Your job location will be at <strong>${esc(input.jobLocation.trim().replace(/\.+$/, ''))}</strong>.
    </li>`
        : ''
    }
    <li style="${num}">
      Your appointment in the organization shall be effective on or before
      <strong>${fmtJoining(input.joiningDate)}</strong>.
    </li>
    <li style="${num}">
      You will also be entitled for following benefits:
      <ul style="margin:6px 0 0;padding-left:20px">${benefits}</ul>
    </li>
    <li style="${num}">
      You are requested to submit copies of following documents and bring along the originals
      (for verification) on your date of joining.
      <ul style="margin:6px 0 0;padding-left:20px">${docs}</ul>
    </li>
    <li style="${num}">
      This offer is valid subject to satisfactory pre-employment medical fitness and shall be
      nullified in case of any deviation in the information provided by you earlier. If any
      document provided by you is identified as false afterwards, shall also be nullified our
      offer of appointment.
    </li>
    <li style="${num}">
      All other terms and conditions of employment will be explained in detail in the appointment
      letter which will be given to you after joining.
    </li>
  </ol>

  <p style="${P}">
    Please return a copy of this letter duly signed by you as token of your acceptance of the offer.<br>
    Looking forward to welcome you and seeing yourself as a team member of ${unitSentenceEnd(input.unitFactory)}
  </p>

${signatures(input)}`);
}

export function buildOfferLetter(
  format: LetterFormat,
  input: LetterInput,
): string {
  return format === 'senior' ? seniorOffer(input) : juniorOffer(input);
}

/**
 * The appointment letter — issued after joining, once verification is done.
 *
 * Both offer formats promise this (the junior one calls it a Service Agreement
 * letter), so it is one document rather than two.
 */
export function buildAppointmentLetter(input: LetterInput): string {
  // Escaped like every other interpolated value: this lands in HTML that is
  // rendered with dangerouslySetInnerHTML in the review modal and emailed out.
  const title = input.salutation?.trim()
    ? `${esc(input.salutation.trim())} `
    : '';
  return shell(`
  <p style="${P}">
    Date: ${fmtDate(input.date ?? new Date())}<br>
    Ref: ${esc(input.reference ?? '')}
  </p>

  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:11pt;margin:0 0 14px">
    <tr>
      <td style="padding:0 0 2px;font-weight:700;width:110px">Name</td>
      <td style="padding:0 0 2px;font-weight:700">: ${title}${esc(input.candidateName)}</td>
    </tr>
    <tr>
      <td style="padding:0;font-weight:700">Address</td>
      <td style="padding:0">: ${esc(input.address ?? '')}</td>
    </tr>
  </table>

  <p style="text-align:center;margin:0 0 16px">
    <span style="font-weight:700;text-decoration:underline;font-size:12pt">Appointment Letter</span>
  </p>

  <p style="${P};font-weight:700">Dear ${title}${esc(lastName(input.candidateName))},</p>

  <p style="${P}">
    With reference to our offer letter${input.reference ? '' : ''} and your subsequent joining, we are pleased to
    confirm your appointment as
    <strong>${esc(positionTitle(input.designation, input.department))}</strong> in
    <strong>${esc(input.unitFactory)}</strong> with effect from
    <strong>${fmtJoining(input.joiningDate)}</strong>.
  </p>

  <p style="${P}">
    Your appointment is governed by the terms and conditions of the Company's service rules as
    amended from time to time. You are required to devote your whole time and attention to the
    business of the Company and to carry out the duties assigned to you faithfully and diligently.
  </p>

  <p style="${P}">
    All other terms and conditions of your service, including remuneration, leave, and separation,
    are as communicated to you and as set out in the Company's policy in force.
  </p>

  <p style="${P}">
    Please sign and return the duplicate copy of this letter as token of your acceptance.
  </p>

  <p style="${P}">
    We welcome you to ${esc(input.unitFactory.replace(/\.+$/, ''))} and wish you a long and successful career with us.
  </p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px;font-size:11pt">
    <tr>
      <td style="width:50%">Yours sincerely,</td>
      <td style="width:50%">Accepted by,</td>
    </tr>
    <tr>
      <td style="padding-top:12px">
        <div style="height:44px">${signatureInk(input.signatorySignature)}</div>
        <div style="border-top:1px solid #000;width:230px"></div>
        <div style="font-weight:700;margin-top:4px">${esc(input.signatoryName)}</div>
        <div>${esc(input.signatoryTitle)}</div>
      </td>
      <td style="padding-top:12px">
        <div style="height:44px">${candidateSignSlot(input)}</div>
        <div style="border-top:1px solid #000;width:270px"></div>
        <div style="font-weight:700;margin-top:4px;text-align:center;width:270px">${esc(input.candidateName)}</div>
      </td>
    </tr>
  </table>`);
}

/** "06 (six)" — the junior letter spells the probation period out. */
function numberWord(n: number): string {
  const words = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
  ];
  return words[n] ?? String(n);
}
