import type { CvEmployment, CvProfile, CvReference } from './cv-profile.types';

/**
 * The BDJobs CV — a candidate's application, laid out as Bdjobs' own
 * "details CV" is: name and contact lines with the photo beside them, grey
 * section bands, the jobs numbered with their years, and the education,
 * training and qualifications in ruled tables. HR know that page; the CV here
 * reads the same way (owner's reference, 2026-10-13).
 *
 * Built from `CvProfile`, so it is also what an applicant who never sent a
 * file gets as their CV. Served as a PDF in a new tab
 * (`CandidatesService.bdjobsCvPdf`), and as HTML where no browser is
 * available to print one.
 *
 * Inline styles throughout and no external assets — the photo is a data: URI
 * — so the page renders the same in Chrome's PDF printer, a browser tab, and
 * anywhere the markup is pasted.
 *
 * It still says, in small print at the foot, that it was generated: an
 * interviewer who believes the candidate wrote it would read Bdjobs' form
 * design as the candidate's choices.
 */

const esc = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Bdjobs pads free text with backticks; "govt girl``````s school" is real. */
const tidy = (v: string): string =>
  v.replace(/[`´]+/g, "'").replace(/\s+/g, ' ').replace(/'{2,}/g, "'").trim();

const text = (v: string | number | undefined | null): string | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  const t = (v ?? '').trim();
  return t ? tidy(t) : null;
};

/** Free text with its line breaks kept — duties, objectives, achievements. */
const para = (v: string | undefined | null): string | null => {
  const lines = (v ?? '')
    .split(/\r?\n/)
    .map((l) => tidy(l))
    .filter(Boolean);
  return lines.length ? lines.map(esc).join('<br>') : null;
};

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "01 Feb, 2024", as Bdjobs prints a date. Read from the ISO day itself, so no zone can move it. */
function dmy(iso?: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${m[3]} ${month}, ${m[1]}` : null;
}

function months(from: string, to: string): number {
  const a = /^(\d{4})-(\d{2})/.exec(from);
  const b = /^(\d{4})-(\d{2})/.exec(to);
  if (!a || !b) return 0;
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}

/** "2.7 yrs" — one decimal, as Bdjobs writes a span. */
const years = (n: number): string => `${Math.round(n * 10) / 10} yrs`;

function jobYears(job: CvEmployment, today: string): string | null {
  if (!job.from) return null;
  const end = job.to && job.to <= today ? job.to : today;
  const m = months(job.from, end);
  return m > 0 ? years(m / 12) : null;
}

/** M / F / male → Male / Female; anything else as written. */
function gender(v?: string | null): string | null {
  const t = text(v);
  if (!t) return null;
  if (/^m(ale)?$/i.test(t)) return 'Male';
  if (/^f(emale)?$/i.test(t)) return 'Female';
  return t;
}

const money = (n?: number): string | null =>
  n ? `Tk. ${n.toLocaleString('en-US')}` : null;

// --- styles ------------------------------------------------------------------

const INK = '#1f2328';
const S = {
  page: `font-family:Inter,'Segoe UI',Roboto,Arial,Helvetica,sans-serif;max-width:820px;margin:0 auto;padding:6px 4px;color:${INK};background:#fff;font-size:12.5px;line-height:1.5`,
  name: 'margin:0 0 12px;font-size:21px;line-height:1.25;font-weight:600;color:#2e3192',
  contactRow:
    'margin:0 0 8px;border-collapse:collapse;font-size:12.5px;color:#30343b',
  icon: 'display:block;width:14px;height:14px;margin-top:2px',
  photo:
    'width:116px;height:146px;object-fit:cover;display:block;border:1px solid #d6d9de;border-radius:4px;padding:3px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12)',
  rule: `border:0;border-top:1.5px solid ${INK};margin:14px 0 4px`,
  band: 'margin:16px 0 10px;padding:7px 8px;background:#e7e7e7;font-size:14px;font-weight:600;color:#6b6f76;page-break-after:avoid;break-after:avoid',
  body: 'margin:0;padding:0 6px',
  table: 'width:100%;border-collapse:collapse;font-size:12px',
  th: 'border:1px solid #d6d9de;padding:7px 6px;font-weight:600;text-align:center;color:#1f2328;background:#fff',
  td: 'border:1px solid #d6d9de;padding:7px 6px;text-align:center;vertical-align:middle;color:#30343b',
  label: 'padding:3px 6px 3px 6px;width:34%;vertical-align:top;color:#30343b',
  colon: 'padding:3px 6px;width:3%;vertical-align:top;color:#30343b',
  value: 'padding:3px 6px;vertical-align:top;color:#30343b',
  strong: 'font-weight:600;color:#1f2328',
  footer:
    'margin:22px 0 0;padding-top:8px;border-top:1px solid #e3e5e8;font-size:10px;color:#9aa0a8;line-height:1.5',
  keep: 'page-break-inside:avoid;break-inside:avoid',
};

/** Small line icons for the contact lines, drawn inline so nothing is fetched. */
const ICON: Record<string, string> = {
  address:
    '<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="#30343b"/><circle cx="12" cy="10" r="2.6" fill="#fff"/>',
  phone:
    '<rect x="7" y="2.5" width="10" height="19" rx="2" fill="none" stroke="#30343b" stroke-width="2"/><line x1="10.5" y1="18" x2="13.5" y2="18" stroke="#30343b" stroke-width="2"/>',
  email:
    '<rect x="3" y="5.5" width="18" height="13" rx="1.5" fill="none" stroke="#30343b" stroke-width="2"/><path d="M3.5 6.5 12 13l8.5-6.5" fill="none" stroke="#30343b" stroke-width="2"/>',
  facebook:
    '<path d="M13.5 22v-8h2.7l.4-3.2h-3.1V8.9c0-.9.3-1.6 1.6-1.6h1.7V4.4c-.3 0-1.3-.1-2.5-.1-2.5 0-4.1 1.5-4.1 4.2v2.3H7.4V14h2.8v8z" fill="#30343b"/>',
  linkedin:
    '<rect x="3" y="9" width="4" height="12" fill="#30343b"/><circle cx="5" cy="5" r="2.2" fill="#30343b"/><path d="M10 9h3.8v1.7c.6-1 1.9-2 3.9-2 4 0 4.3 2.6 4.3 6V21h-4v-5.5c0-1.4 0-3.2-2-3.2s-2.2 1.5-2.2 3.1V21H10z" fill="#30343b"/>',
};

const icon = (name: keyof typeof ICON): string =>
  `<svg viewBox="0 0 24 24" style="${S.icon}" aria-hidden="true">${ICON[name]}</svg>`;

const band = (title: string): string =>
  `<div style="${S.band}">${esc(title)}</div>`;

const cell = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? '' : esc(String(v));

function grid(head: string[], rows: string[][], widths: string[] = []): string {
  return `<table style="${S.table}">
    <tr>${head
      .map(
        (h, i) =>
          `<th style="${S.th}${widths[i] ? `;width:${widths[i]}` : ''}">${esc(h)}</th>`,
      )
      .join('')}</tr>
    ${rows
      .map(
        (r) =>
          `<tr style="${S.keep}">${r.map((c) => `<td style="${S.td}">${c}</td>`).join('')}</tr>`,
      )
      .join('')}
  </table>`;
}

/** "Label : value" lines, as Bdjobs prints personal and career details. */
function pairs(items: [string, string | null][]): string {
  const shown = items.filter(([, v]) => v);
  if (!shown.length) return '';
  return `<table style="width:100%;border-collapse:collapse;font-size:12.5px">${shown
    .map(
      ([k, v]) => `<tr>
        <td style="${S.label}">${esc(k)}</td>
        <td style="${S.colon}">:</td>
        <td style="${S.value}">${v}</td>
      </tr>`,
    )
    .join('')}</table>`;
}

// --- sections ------------------------------------------------------------------

function experienceSection(p: CvProfile, today: string): string {
  const jobs = p.employment;
  const total =
    p.summary.statedExperienceYears ?? p.summary.totalExperienceYears;
  if (!jobs.length && !total) return '';
  const items = jobs
    .map((j, i) => {
      const span = jobYears(j, today);
      const from = dmy(j.from);
      const to = j.current ? 'Continuing' : dmy(j.to);
      const dates =
        from || to ? `(${[from ?? '?', to ?? '?'].join(' - ')} )` : null;
      const title = text(j.designation) ?? text(j.company) ?? '';
      return `<tr style="${S.keep}">
        <td style="width:22px;vertical-align:top;padding:0 0 12px 6px">${i + 1}.</td>
        <td style="vertical-align:top;padding:0 6px 12px 4px">
          <div style="${S.strong}">${esc(title)}${span ? ` (${esc(span)})` : ''}</div>
          ${dates ? `<div>${esc(dates)}</div>` : ''}
          <div style="${S.strong};margin-top:4px">${esc(j.company)}</div>
          ${j.location ? `<div>${esc(j.location)}</div>` : ''}
          ${
            j.expertise
              ? `<div style="${S.strong};margin-top:6px">Area of Expertise</div><div>${esc(j.expertise)}</div>`
              : ''
          }
          ${
            para(j.role)
              ? `<div style="${S.strong};margin-top:6px">Duties/Responsibilities</div><div>${para(j.role)}</div>`
              : ''
          }
        </td>
      </tr>`;
    })
    .join('');
  return `${band('Experience')}
  ${
    total
      ? `<p style="${S.body};margin-bottom:10px"><span style="${S.strong}">Total Year of Experience:</span> ${esc(years(total))}</p>`
      : ''
  }
  ${items ? `<table style="width:100%;border-collapse:collapse;font-size:12.5px">${items}</table>` : ''}`;
}

function educationSection(p: CvProfile): string {
  if (!p.education.length) return '';
  return `${band('Academic / Education')}
  ${grid(
    [
      'Exam Title',
      'Concentration/ Major',
      'Institute',
      'Result',
      'Pas.Year',
      'Duration',
      'Achievement',
    ],
    p.education.map((q) => [
      cell(q.degree),
      cell(q.major),
      `${cell(q.institute)}${
        q.university
          ? `<div style="color:#6b6f76;font-size:11px">${esc(q.university)}</div>`
          : ''
      }`,
      cell(q.result),
      cell(q.passYear),
      cell(q.duration),
      para(q.achievement) ?? '',
    ]),
    ['14%', '13%', '20%', '11%', '9%', '10%', ''],
  )}`;
}

function trainingSection(p: CvProfile): string {
  if (!p.training?.length) return '';
  return `${band('Training')}
  ${grid(
    [
      'Training Title',
      'Topic',
      'Institute',
      'Country',
      'Location',
      'Year',
      'Duration',
    ],
    p.training.map((t) => [
      cell(t.title),
      cell(t.topic),
      cell(t.institute),
      cell(t.country),
      cell(t.location),
      cell(t.year),
      cell(t.duration),
    ]),
  )}`;
}

function qualificationSection(p: CvProfile): string {
  if (!p.certifications?.length) return '';
  return `${band('Professional Qualification')}
  ${grid(
    ['Certification', 'Institute', 'Location', 'From', 'To'],
    p.certifications.map((c) => [
      cell(c.name),
      cell(c.institute),
      cell(c.location),
      cell(dmy(c.from)),
      cell(dmy(c.to)),
    ]),
    ['25%', '27%', '14%', '17%', '17%'],
  )}`;
}

function careerSection(p: CvProfile): string {
  const c = p.career;
  const list = (v?: string[]) => (v?.length ? esc(v.join(', ')) : null);
  const body = pairs([
    ['Preferred Job Category', list(c?.preferredJobCategories)],
    [
      'Looking For',
      text(c?.jobLevel) ? esc(text(c?.jobLevel) as string) : null,
    ],
    ['Present Salary', money(p.compensation.current)],
    ['Expected Salary', money(p.compensation.expected)],
    ['Preferred District', list(c?.preferredDistricts)],
    ['Preferred Organization Types', list(c?.preferredOrganizationTypes)],
  ]);
  return body ? `${band('Career and Application Information')}${body}` : '';
}

function skillSection(p: CvProfile): string {
  const skills = p.skills ?? [];
  if (!skills.length) return '';
  const described = skills.some((s) => s.description);
  const rows = described
    ? skills.map((s) => [
        `<div style="text-align:left">${esc(s.name)}</div>`,
        `<div style="text-align:left">${cell(s.description)}</div>`,
      ])
    : [
        [
          `<ul style="margin:0;padding-left:16px;text-align:left">${skills
            .map((s) => `<li style="margin:3px 0">${esc(s.name)}</li>`)
            .join('')}</ul>`,
          '<div style="color:#9aa0a8;font-style:italic;text-align:left">No description provided</div>',
        ],
      ];
  return `${band('Skill')}${grid(['Fields of Skill', 'Description'], rows, ['38%', ''])}`;
}

function languageSection(p: CvProfile): string {
  if (!p.languages?.length) return '';
  return `${band('Language Proficiency')}
  <div style="width:74%;margin:0 auto">${grid(
    ['Language', 'Reading', 'Writing', 'Speaking'],
    p.languages.map((l) =>
      [l.language, l.reading, l.writing, l.speaking].map(
        (v) => `<div style="text-align:left">${cell(v)}</div>`,
      ),
    ),
  )}</div>`;
}

function personalSection(p: CvProfile): string {
  const height = p.personal.heightMeters;
  const permanent = text(p.contact.permanentAddress);
  const current = text(p.contact.currentAddress);
  const body = pairs([
    [
      "Father's Name",
      text(p.personal.fatherName) ? esc(text(p.personal.fatherName)!) : null,
    ],
    [
      "Mother's Name",
      text(p.personal.motherName) ? esc(text(p.personal.motherName)!) : null,
    ],
    [
      'Date of Birth',
      dmy(p.personal.dateOfBirth) ? esc(dmy(p.personal.dateOfBirth)!) : null,
    ],
    [
      'Gender',
      gender(p.personal.gender) ? esc(gender(p.personal.gender)!) : null,
    ],
    [
      'Marital Status',
      text(p.personal.maritalStatus)
        ? esc(text(p.personal.maritalStatus)!)
        : null,
    ],
    [
      'Nationality',
      text(p.personal.nationality) ? esc(text(p.personal.nationality)!) : null,
    ],
    [
      'National Id No.',
      text(p.personal.nationalId) ? esc(text(p.personal.nationalId)!) : null,
    ],
    [
      'Religion',
      text(p.personal.religion) ? esc(text(p.personal.religion)!) : null,
    ],
    [
      'Blood Group',
      text(p.personal.bloodGroup)
        ? esc(text(p.personal.bloodGroup)!.toUpperCase())
        : null,
    ],
    ['Height (Meter)', height ? esc(String(height)) : null],
    [
      'Weight (Kg)',
      p.personal.weightKg ? esc(String(p.personal.weightKg)) : null,
    ],
    // The present address heads the page; the permanent one only when it differs.
    [
      'Permanent Address',
      permanent && permanent.toLowerCase() !== (current ?? '').toLowerCase()
        ? esc(permanent)
        : null,
    ],
  ]);
  return body ? `${band('Personal Details')}${body}` : '';
}

function referenceBlock(r: CvReference): string {
  return pairs([
    ['Name', esc(r.name)],
    ['Organization', text(r.organization) ? esc(text(r.organization)!) : null],
    ['Designation', text(r.designation) ? esc(text(r.designation)!) : null],
    ['Address', text(r.address) ? esc(text(r.address)!) : null],
    ['Email', text(r.email) ? esc(text(r.email)!) : null],
    ['Mobile', text(r.phone) ? esc(text(r.phone)!) : null],
    ['Relation', text(r.relation) ? esc(text(r.relation)!) : null],
  ]);
}

function referenceSection(p: CvProfile): string {
  const refs = p.references ?? [];
  if (!refs.length) return '';
  // Two to a row with a rule between them, as on Bdjobs' page.
  const rows: string[] = [];
  for (let i = 0; i < refs.length; i += 2) {
    const [a, b] = [refs[i], refs[i + 1]];
    rows.push(`<tr style="${S.keep}">
      <td style="width:50%;vertical-align:top;padding:0 10px 12px 0">${referenceBlock(a)}</td>
      <td style="width:50%;vertical-align:top;padding:0 0 12px 10px;border-left:1px solid #e3e5e8">${b ? referenceBlock(b) : ''}</td>
    </tr>`);
  }
  return `${band('Reference')}<table style="width:100%;border-collapse:collapse">${rows.join('')}</table>`;
}

/**
 * Render a CV.
 *
 * `now` is injectable so every span and the "generated on" line can be
 * asserted in a test rather than drifting with the clock.
 */
export function buildCvDocument(
  profile: CvProfile,
  now: Date = new Date(),
  /** The applicant's photo as a data: URI, when one was received. */
  photo?: string | null,
): string {
  const today = now.toISOString().slice(0, 10);
  const name = text(profile.personal.fullName) ?? 'Candidate name not supplied';
  const salutation = text(profile.personal.salutation);

  const address =
    text(profile.contact.currentAddress) ??
    text(profile.contact.currentLocation);
  const contact: [keyof typeof ICON, string | null][] = [
    ['address', address],
    ['phone', text(profile.contact.phone)],
    ['email', text(profile.contact.email)],
    ['facebook', text(profile.contact.facebookUrl)],
    ['linkedin', text(profile.contact.linkedinUrl)],
  ];
  // A row per line, icon in its own cell, so a long address wraps under its
  // own first line rather than back under the icon.
  const contactRows = contact
    .filter(([, v]) => v)
    .map(
      ([k, v]) => `<table style="${S.contactRow}"><tr>
        <td style="width:24px;vertical-align:top;padding:0">${icon(k)}</td>
        <td style="vertical-align:top;padding:0">${esc(v as string)}</td>
      </tr></table>`,
    )
    .join('');

  // Only an inline image is ever embedded; see candidate-photo.ts.
  const photoTag =
    photo && /^data:image\/(jpeg|png|webp);base64,/.test(photo)
      ? `<img src="${photo}" alt="" style="${S.photo}">`
      : '';

  const objective = para(profile.careerObjective);
  const cover = para(profile.coverLetter);
  const sourceLabel =
    profile.source === 'bdjobs'
      ? 'the BDJobs application'
      : profile.source === 'upload'
        ? 'an uploaded document'
        : 'details entered by the recruiter';

  return `<div style="${S.page}">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:top;padding:6px 0 0 6px">
      <h1 style="${S.name}">${esc([salutation, name].filter(Boolean).join(' '))}</h1>
      ${contactRows}
    </td>
    ${photoTag ? `<td style="vertical-align:top;width:126px;padding:0 4px 0 16px">${photoTag}</td>` : ''}
  </tr></table>
  <hr style="${S.rule}" />
  ${objective ? `${band('Career Objective')}<p style="${S.body}">${objective}</p>` : ''}
  ${
    cover && profile.coverLetter?.trim() !== profile.careerObjective?.trim()
      ? `${band('Cover Letter')}<p style="${S.body}">${cover}</p>`
      : ''
  }
  ${experienceSection(profile, today)}
  ${educationSection(profile)}
  ${trainingSection(profile)}
  ${qualificationSection(profile)}
  ${careerSection(profile)}
  ${skillSection(profile)}
  ${languageSection(profile)}
  ${personalSection(profile)}
  ${referenceSection(profile)}
  <p style="${S.footer}">
    Generated by DBL HRM from ${esc(sourceLabel)} on ${esc(
      now.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Dhaka',
      }),
    )} — a formatted record of the details the candidate submitted, not a CV
    they wrote; anything missing was not asked for, rather than left out.
  </p>
</div>`;
}

/** The same CV as a whole page, for a browser tab or the PDF printer. */
export function buildCvPage(
  profile: CvProfile,
  now: Date = new Date(),
  photo?: string | null,
): string {
  const title = `${text(profile.personal.fullName) ?? 'Candidate'} — CV`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#fff">${buildCvDocument(profile, now, photo)}</body></html>`;
}
