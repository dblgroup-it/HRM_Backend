/**
 * DBL's "Pre Employment Reference Check", transcribed from the paper form.
 *
 * The recruiter fills it in while they are on the call, so this renders their
 * answers back onto the same layout HR already reads — including the rating
 * scales, which are printed with the chosen option marked rather than reduced
 * to a word, so the form looks like the one that was always filed.
 */

export const RATING_SCALE = [
  'excellent',
  'good',
  'average',
  'unsatisfactory',
] as const;

export const QUALITY_SCALE = [
  'consistently_high',
  'meets_requirements',
  'needs_improvement',
] as const;

export type Rating = (typeof RATING_SCALE)[number];
export type QualityRating = (typeof QUALITY_SCALE)[number];

const RATING_LABEL: Record<string, string> = {
  excellent: 'Excellent',
  good: 'Good',
  average: 'Average',
  unsatisfactory: 'Unsatisfactory',
  consistently_high: 'Consistently high quality',
  meets_requirements: 'Meets job requirements',
  needs_improvement: 'Needs improvement',
};

/** The nine scored questions, in the order the paper form asks them. */
export const RATING_QUESTIONS = [
  {
    key: 'trustworthiness',
    letter: 'a',
    text: 'Assess him/her on the basis of trustworthiness',
    scale: RATING_SCALE,
  },
  {
    key: 'values',
    letter: 'b',
    text: 'Assess the candidate on the ground of following organizational values and ethics',
    scale: RATING_SCALE,
  },
  {
    key: 'strategy',
    letter: 'c',
    text: 'What sorts of strategical know how the individual have while making any decision?',
    scale: RATING_SCALE,
  },
  {
    key: 'peers',
    letter: 'd',
    text: 'Assess the candidate on the ground of in relation with the peers / supervisor?',
    scale: RATING_SCALE,
  },
  {
    key: 'quality',
    letter: 'e',
    text: 'How would you rate his/her quality of work performed in the organization?',
    scale: QUALITY_SCALE,
  },
  {
    key: 'commitment',
    letter: 'f',
    text: 'What is the level of Commitment the individuals possesses in the Job?',
    scale: RATING_SCALE,
  },
  {
    key: 'creativity',
    letter: 'g',
    text: 'Level of Creativity while solving any problem',
    scale: RATING_SCALE,
  },
  {
    key: 'communication',
    letter: 'h',
    text: 'How would you rate his/her interpersonal communication skills?',
    scale: RATING_SCALE,
  },
  {
    key: 'integrity',
    letter: 'i',
    text: 'How well do the candidates maintain their level of integrity while performing the assigned job duties?',
    scale: RATING_SCALE,
  },
] as const;

export interface ReferenceCheckInput {
  candidateName: string;
  positionApplied: string;
  refereeName: string;
  refereeDesignation?: string | null;
  refereeOrganization?: string | null;
  refereeEmail?: string | null;
  refereePhone?: string | null;
  knownDuration?: string | null;
  relationship?: string | null;
  strengths?: string | null;
  weaknesses?: string | null;
  ratings?: Record<string, string> | null;
  handover?: string | null;
  rehireEligible?: string | null;
  concerns?: string | null;
  overallComments?: string | null;
  conductedByName: string;
  conductedByEmployeeCode?: string | null;
  /** The recruiter's stored e-signature, when they have one on their profile. */
  conductedBySignature?: string | null;
  conductedAt: Date;
}

const esc = (v: string | null | undefined) =>
  (v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Free text keeps the line breaks the recruiter typed. */
const multiline = (v: string | null | undefined) =>
  esc(v).replace(/\n/g, '<br>');

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

const TD = 'border:1px solid #000;padding:5px 7px;vertical-align:top';
const LBL = `${TD};font-size:9.5pt`;
const VAL = `${TD};font-size:9.5pt`;

/** One scale, with the chosen option filled in — the paper form's tick mark. */
function scale(options: readonly string[], chosen?: string): string {
  return options
    .map((opt) => {
      const on = opt === chosen;
      const mark = on
        ? '<span style="display:inline-block;width:8px;height:8px;border:1px solid #000;border-radius:50%;background:#000;margin-right:6px"></span>'
        : '<span style="display:inline-block;width:8px;height:8px;border:1px solid #000;border-radius:50%;margin-right:6px"></span>';
      return `<div style="font-size:9.5pt;line-height:1.5;${on ? 'font-weight:700' : ''}">${mark}${esc(RATING_LABEL[opt] ?? opt)}</div>`;
    })
    .join('');
}

export function buildReferenceCheckForm(input: ReferenceCheckInput): string {
  const row = (no: string, question: string, answer: string) =>
    `<tr>
      <td style="${LBL};width:22px;text-align:center">${no}</td>
      <td style="${LBL};width:44%">${question}</td>
      <td style="${VAL}">${answer}</td>
    </tr>`;

  const ratingRows = RATING_QUESTIONS.map(
    (q) => `<tr>
      <td style="${LBL};width:22px;text-align:center">${q.letter}</td>
      <td style="${LBL};width:44%">${esc(q.text)}</td>
      <td style="${VAL}">${scale(q.scale, input.ratings?.[q.key])}</td>
    </tr>`,
  ).join('');

  const detail = (label: string, value: string) =>
    `<tr>
      <td style="width:170px;padding:3px 0;font-size:10pt;font-weight:700">${esc(label)}</td>
      <td style="width:14px;padding:3px 0;font-size:10pt">:</td>
      <td style="padding:3px 0;font-size:10pt;border-bottom:1px solid #c7ccd3">${value}</td>
    </tr>`;

  return `
<div class="dbl-refcheck" style="font-family:Calibri,'Segoe UI',Arial,sans-serif;color:#000;max-width:800px;margin:0 auto;padding:22px 30px;background:#fff">
  <style>
    @media print { .dbl-refcheck { max-width: none !important; padding: 0 !important } }
    .dbl-refcheck table { border-collapse: collapse; width: 100% }
    .dbl-refcheck tr { break-inside: avoid }
  </style>

  <p style="margin:0 0 4px;text-align:center;font-size:14pt;font-weight:700;letter-spacing:.3px">
    P<span style="font-size:11.5pt">RE</span> E<span style="font-size:11.5pt">MPLOYMENT</span>
    R<span style="font-size:11.5pt">EFERENCE</span> C<span style="font-size:11.5pt">HECK</span>
  </p>
  <div style="border-bottom:1px solid #c7ccd3;margin:0 0 14px"></div>

  <p style="margin:0 0 12px;font-size:10pt;line-height:1.5;text-align:justify">
    <b><u>To the Referee</u></b>: With reference to
    <b>${esc(input.candidateName)}</b>, please provide us with the following
    information regarding different aspects of the candidate&rsquo;s personal
    profile. The information provided will be kept strictly confidential.
  </p>

  <table>
    <tr>
      <td style="${LBL};width:22px"></td>
      <td style="${LBL};width:44%;font-weight:700">Name of the candidate</td>
      <td style="${VAL}">${esc(input.candidateName)}</td>
    </tr>
    <tr>
      <td style="${LBL};width:22px"></td>
      <td style="${LBL};font-weight:700">Name of the position applied</td>
      <td style="${VAL}">${esc(input.positionApplied)}</td>
    </tr>
    ${row('1', 'a) How long have you known the applicant?', multiline(input.knownDuration))}
    ${row('', 'b) Your relationship with the applicant?', multiline(input.relationship))}
    ${row('2', 'a) To your observation, what are the candidate&rsquo;s strengths?', multiline(input.strengths))}
    ${row('', 'b) To your observation, what are the candidate&rsquo;s weaknesses?', multiline(input.weaknesses))}
    <tr>
      <td style="${LBL};width:22px;text-align:center">3</td>
      <td style="${LBL}" colspan="2">
        Please evaluate the candidate on the following scale
      </td>
    </tr>
    ${ratingRows}
    ${row('4', '&ldquo;Did the individual bestow the assigned job duties and financial accountabilities before leaving?&rdquo;', multiline(input.handover))}
    ${row('5', 'Do you think he/she is eligible for rehiring in your organization again? If no, why not?', multiline(input.rehireEligible))}
    ${row('6', 'Is there anything in the person&rsquo;s performance history (i.e. disciplinary or legal issues) that would raise a question of their employability? If yes please describe the cause.', multiline(input.concerns))}
    ${row('7', 'Do you have any overall comments on the candidate?', multiline(input.overallComments))}
  </table>

  <table style="margin-top:22px">
    ${detail('Name of the Referee', esc(input.refereeName))}
    ${detail('Designation', esc(input.refereeDesignation))}
    ${detail('Organization', esc(input.refereeOrganization))}
    ${detail('Email', esc(input.refereeEmail))}
    ${detail('Telephone/Mobile', esc(input.refereePhone))}
  </table>

  <p style="margin:22px 0 6px;font-size:10pt;font-weight:700">Reference Check Conducted by:</p>
  <table>
    ${detail('Name', esc(input.conductedByName))}
    ${detail('Employee ID', esc(input.conductedByEmployeeCode))}
    ${detail(
      'Signature',
      input.conductedBySignature
        ? `<img src="${input.conductedBySignature}" alt="" style="height:30px;width:auto;display:block;margin:2px 0">`
        : '',
    )}
    ${detail('Date', esc(fmtDate(input.conductedAt)))}
  </table>

  <p style="margin:18px 0 0;text-align:right;font-size:9pt;font-style:italic;color:#444">
    Group Corporate Human Resources, DBL
  </p>
</div>`;
}
