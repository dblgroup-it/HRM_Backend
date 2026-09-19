/**
 * The pre-employment medical test letter.
 *
 * Two versions exist on paper and they differ in substance, not wording: a
 * candidate of forty or above gets an eighth test (S/Creatinine) and the letter
 * goes out over Group Human Resources rather than Corporate Human Resources.
 * Sending the wrong list means the clinic does not run a test somebody decided
 * was necessary, so the band is part of the letter rather than a formatting
 * choice.
 *
 * Pure and free of Nest so the exact wording can be asserted — this goes to an
 * external clinic over DBL's name.
 */

export type MedicalAgeBand = 'below_40' | 'above_40';

/** Where the split falls. Forty and above takes the longer list. */
export const MEDICAL_AGE_THRESHOLD = 40;

export interface MedicalLetterInput {
  candidateName: string;
  /** "Mr." / "Ms." — omitted rather than guessed. */
  salutation?: string | null;
  /** The unit the candidate is being hired into, as the letter names it. */
  unitName: string;
  refNo: string;
  band: MedicalAgeBand;
  /** Date and time of the appointment. */
  examAt: Date;
  /** Falls back to MEDICAL_TEST_VENUE when not given. */
  venue?: string;
  letterDate?: Date;
}

const esc = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** "August 16, 2026" — how the letterhead dates it. */
const letterheadDate = (d: Date): string =>
  d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

/** "29-Aug-2026 (Saturday) at 10.30 AM" — how the appointment reads. */
export function appointmentText(d: Date): string {
  const day = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const date = d
    .toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
    .replace(/ /g, '-');
  const time = d
    .toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
    .replace(':', '.')
    .toUpperCase();
  return `${date} (${day}) at ${time}`;
}

/**
 * Which list applies, from a date of birth.
 *
 * Returns null when there is no usable date — Bdjobs applicants frequently have
 * none, and guessing the band would either skip a test or invent one. The
 * caller asks HR instead.
 */
export function bandFromDateOfBirth(
  dob: string | Date | null | undefined,
  now: Date = new Date(),
): MedicalAgeBand | null {
  if (!dob) return null;
  const d = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(d.getTime())) return null;

  let age = now.getFullYear() - d.getFullYear();
  const beforeBirthday =
    now.getMonth() < d.getMonth() ||
    (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
  if (beforeBirthday) age -= 1;

  if (age < 0 || age > 120) return null; // Nonsense in, nothing out.
  return age >= MEDICAL_AGE_THRESHOLD ? 'above_40' : 'below_40';
}

/** The tests, in the order the paper letter lists them. */
export function testsFor(band: MedicalAgeBand): string[] {
  const common = [
    'Blood Grouping &amp; Rh typing;',
    'Routine Urine tests Urine R/E (Sugar &amp; albumin);',
    'Blood test for ESR, Hb, VDRL, SGPT, RBS and Liver function;',
    'Normal Eye Test;',
    'General Health Checkup;',
    'Family history of any illness or diseases;',
  ];
  return band === 'above_40'
    ? [...common, 'HBs Ag Test; and', 'S/Creatinine']
    : [...common, 'HBs Ag Test;'];
}

/**
 * The letter itself, laid out in the email body.
 *
 * No attachment by business decision: the clinic reads the instruction and the
 * test list, and an email they can forward is enough. Inline styles throughout
 * because mail clients strip stylesheets.
 */
export function buildMedicalTestLetter(input: MedicalLetterInput): string {
  const date = input.letterDate ?? new Date();
  const who = [input.salutation, input.candidateName].filter(Boolean).join(' ');
  const signatory =
    input.band === 'above_40'
      ? 'Group Human Resources'
      : 'Corporate Human Resources';
  const listLabel =
    input.band === 'above_40'
      ? '40 years &amp; above age level'
      : 'below 40 years';

  const items = testsFor(input.band)
    .map(
      (t, i) =>
        `<tr>
          <td style="padding:1px 6px 1px 0;vertical-align:top;font-weight:bold;white-space:nowrap">${i + 1}.</td>
          <td style="padding:1px 0;vertical-align:top">${t}</td>
        </tr>`,
    )
    .join('');

  return `<div style="font-family:'Times New Roman',Times,serif;font-size:15px;line-height:1.5;color:#111;max-width:760px">
  <p style="margin:0">Date: ${esc(letterheadDate(date))}</p>
  <p style="margin:14px 0 0">Ref: ${esc(input.refNo)}</p>

  <p style="margin:18px 0 0">To<br/>
  The Concern<br/>
  Medical and Health Care Services<br/>
  DBL Group<br/>
  Sardagonj, Kashimpur<br/>
  Gazipur</p>

  <p style="margin:20px 0 0"><strong><u>Medical Tests</u></strong></p>

  <p style="margin:16px 0 0">Dear Concern:</p>

  <p style="margin:16px 0 0;text-align:justify">
    We are pleased to send <strong>${esc(who)}, Unit - ${esc(input.unitName)}</strong>
    for doing the Pre-employment Medical Assessment and incidental things
    mentioned below and expect your comment as to his fitness for employment:
  </p>

  <p style="margin:16px 0 0">List of the medical tests and incidental things (${listLabel}):</p>

  <table style="margin:10px 0 0;border-collapse:collapse">${items}</table>

  <p style="margin:16px 0 0">The photograph of the candidate is also printed herewith.</p>

  <p style="margin:18px 0 0">
    <strong>Appointment:</strong> ${esc(appointmentText(input.examAt))}<br/>
    <strong>Venue:</strong> ${esc(input.venue?.trim() || MEDICAL_TEST_VENUE)}
  </p>

  <p style="margin:20px 0 0">Thanking you.</p>
  <p style="margin:18px 0 0">Yours faithfully,</p>
  <p style="margin:34px 0 0">_______________________<br/>${esc(signatory)}<br/>DBL Group</p>
</div>`;
}

/** The documents a candidate must bring. Printed in the candidate's email. */
/**
 * Where candidates report for the pre-employment medical, by default.
 *
 * Editable per send, because a candidate is occasionally examined elsewhere —
 * but defaulted, because it is the same place almost every time and an address
 * typed from memory on every letter is one that eventually goes out wrong.
 *
 * Whatever is chosen is used for BOTH the clinic's letter and the candidate's
 * email, so the two can never name different places for one appointment.
 */
export const MEDICAL_TEST_VENUE = 'Jinnat Complex, Kashimpur, Gazipur';

export const CANDIDATE_DOCUMENTS = [
  'Four Passport size photographs with white background. (Lab print)',
  'All relevant education certificate and marks sheet (Main copy & Photocopy)',
  'Experiences certificates',
  'Relieving letter and last pay slip from the previous employer (For Experienced Candidates)',
  'Copy of NID & Birth registration/ Passport (at least one)',
  'Copy of residence proof (any govt. Bill)',
  'Copy of TIN/ Last Tax return Submission (if any) (For Experienced Candidates)',
  'Pay Slip / Salary Certificates / Statement (For Experienced Candidates)',
];

/**
 * What the candidate receives.
 *
 * Deliberately not the clinic's letter: the candidate needs where to be, when,
 * and what to bring. The test list is the clinic's business and printing it
 * here invites a candidate to arrive having decided which tests they need.
 */
export function buildCandidateMedicalEmail(input: {
  examAt: Date;
  /** The same venue the clinic's letter names. */
  venue?: string;
  /**
   * The letter's reference.
   *
   * Carried into the candidate's email as well as the clinic's: it is what
   * they are asked for at the desk, and a reference only the clinic holds is
   * no use to the person turning up.
   */
  refNo?: string | null;
}): {
  text: string;
  html: string;
} {
  const when = appointmentText(input.examAt);
  const docs = CANDIDATE_DOCUMENTS;
  const venue = input.venue?.trim() || MEDICAL_TEST_VENUE;

  const ref = input.refNo?.trim() || '';

  const text = `Dear Sir,
Greetings!

You are requested to be present for the pre-employment Medical Test on
${when} to the address given.

${venue}
${ref ? `\nReference: ${ref}\n` : ''}

Please bring the following documents with you
${docs.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Thank You
DBL Corporate HR`;

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:680px">
  <p style="margin:0">Dear Sir,<br/>Greetings!</p>

  <p style="margin:14px 0 0">
    You are requested to be present for the pre-employment Medical Test on
    <strong>${esc(when)}</strong> to the address given.
  </p>

  <p style="margin:14px 0 0;white-space:pre-line">${esc(venue)}</p>
  ${ref ? `<p style="margin:12px 0 0">Reference: <strong>${esc(ref)}</strong></p>` : ''}

  <p style="margin:16px 0 6px">Please bring the following documents with you</p>
  <ol style="margin:0;padding-left:20px">
    ${docs.map((d) => `<li style="margin:2px 0">${esc(d)}</li>`).join('')}
  </ol>

  <p style="margin:18px 0 0">Thank You<br/>DBL Corporate HR</p>
</div>`;

  return { text, html };
}
