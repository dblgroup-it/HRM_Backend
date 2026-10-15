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
 * (`CandidatesController.profileCv`), and as HTML where no browser is
 * available to print one.
 *
 * **Printed as a document, not a web page (2026-10-15).** Every section —
 * its band and its table — is kept together, so a section that does not fit
 * at the foot of a page starts the next one instead of leaving a heading and
 * a table header stranded there; a table longer than a page repeats its
 * header row; a job is never split. The "generated" note and the page number
 * go in the page footer (`cvPrintFooter`), not after the last section, where
 * they used to spill onto a page of their own.
 *
 * Inline styles throughout and no external assets — the photo is a data: URI
 * — so the page renders the same in Chrome's PDF printer, a browser tab, and
 * anywhere the markup is pasted.
 *
 * It still says that it was generated: an interviewer who believes the
 * candidate wrote it would read Bdjobs' form design as the candidate's choices.
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

/** "english" → "English": Bdjobs passes on whatever case the applicant typed. */
const capital = (v: string | null): string | null =>
  v ? v.charAt(0).toUpperCase() + v.slice(1) : v;

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

/** "15 October 2026" in Dhaka. */
const longDate = (d: Date): string =>
  d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Dhaka',
  });

// --- styles ------------------------------------------------------------------

const INK = '#1f2328';
const BODY = '#2b2f36';
const RULE = '#d5dae1';
const KEEP = 'break-inside:avoid;page-break-inside:avoid';
const S = {
  page: `font-family:Inter,'Segoe UI',Roboto,Arial,Helvetica,sans-serif;max-width:820px;margin:0 auto;padding:4px 2px;color:${BODY};background:#fff;font-size:12px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact`,
  name: 'margin:0;font-size:22px;line-height:1.25;font-weight:700;color:#2e3192;letter-spacing:.005em',
  headline: 'margin:3px 0 12px;font-size:13px;font-weight:500;color:#4b515b',
  contactRow: `margin:0 0 6px;border-collapse:collapse;font-size:12px;color:${BODY}`,
  icon: 'display:block;width:13px;height:13px;margin-top:2px',
  photo:
    'width:112px;height:140px;object-fit:cover;display:block;border:1px solid #d6d9de;border-radius:4px;padding:3px;background:#fff',
  rule: `border:0;border-top:1.5px solid ${INK};margin:14px 0 2px`,
  section: `${KEEP};margin-top:16px`,
  band: `margin:0 0 9px;padding:6px 10px;background:#eceef1;font-size:13px;font-weight:700;color:#2f3640;letter-spacing:.015em;border-radius:2px;break-after:avoid;page-break-after:avoid`,
  body: 'margin:0;padding:0 4px',
  table:
    'width:100%;border-collapse:collapse;font-size:11.5px;line-height:1.45',
  th: `border:1px solid ${RULE};padding:6px 7px;font-weight:600;color:${INK};background:#f4f6f8;vertical-align:middle`,
  td: `border:1px solid ${RULE};padding:6px 7px;vertical-align:middle;color:${BODY}`,
  label: `padding:3px 6px 3px 4px;width:30%;vertical-align:top;color:#4b515b`,
  colon: 'padding:3px 6px;width:2%;vertical-align:top;color:#4b515b',
  value: `padding:3px 6px;vertical-align:top;color:${BODY}`,
  strong: `font-weight:600;color:${INK}`,
  sub: `font-weight:600;color:${INK};margin-top:6px`,
  footer: `margin:22px 0 0;padding-top:8px;border-top:1px solid #e3e5e8;font-size:10px;color:#9aa0a8;line-height:1.5`,
};

/** Small line icons for the contact lines, drawn inline so nothing is fetched. */
const ICON: Record<string, string> = {
  address:
    '<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="#3a3f47"/><circle cx="12" cy="10" r="2.6" fill="#fff"/>',
  phone:
    '<rect x="7" y="2.5" width="10" height="19" rx="2" fill="none" stroke="#3a3f47" stroke-width="2"/><line x1="10.5" y1="18" x2="13.5" y2="18" stroke="#3a3f47" stroke-width="2"/>',
  email:
    '<rect x="3" y="5.5" width="18" height="13" rx="1.5" fill="none" stroke="#3a3f47" stroke-width="2"/><path d="M3.5 6.5 12 13l8.5-6.5" fill="none" stroke="#3a3f47" stroke-width="2"/>',
  facebook:
    '<path d="M13.5 22v-8h2.7l.4-3.2h-3.1V8.9c0-.9.3-1.6 1.6-1.6h1.7V4.4c-.3 0-1.3-.1-2.5-.1-2.5 0-4.1 1.5-4.1 4.2v2.3H7.4V14h2.8v8z" fill="#3a3f47"/>',
  linkedin:
    '<rect x="3" y="9" width="4" height="12" fill="#3a3f47"/><circle cx="5" cy="5" r="2.2" fill="#3a3f47"/><path d="M10 9h3.8v1.7c.6-1 1.9-2 3.9-2 4 0 4.3 2.6 4.3 6V21h-4v-5.5c0-1.4 0-3.2-2-3.2s-2.2 1.5-2.2 3.1V21H10z" fill="#3a3f47"/>',
};

const icon = (name: keyof typeof ICON): string =>
  `<svg viewBox="0 0 24 24" style="${S.icon}" aria-hidden="true">${ICON[name]}</svg>`;

/**
 * A section: its band and its content, kept on one page. When it does not
 * fit at the foot of a page it starts the next; one longer than a page
 * breaks between rows, with the table header repeated.
 */
const section = (title: string, content: string): string =>
  content
    ? `<section style="${S.section}"><div style="${S.band}">${esc(title)}</div>${content}</section>`
    : '';

const cell = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? '' : esc(String(v));

type Col = { head: string; width?: string; align?: 'left' | 'center' };

/** A ruled table with a real header row, so Chrome repeats it on every page the table runs to. */
function grid(cols: Col[], rows: string[][]): string {
  const align = (i: number) => `text-align:${cols[i].align ?? 'left'}`;
  return `<table style="${S.table}">
    <thead><tr>${cols
      .map(
        (c, i) =>
          `<th style="${S.th};${align(i)}${c.width ? `;width:${c.width}` : ''}">${esc(c.head)}</th>`,
      )
      .join('')}</tr></thead>
    <tbody>${rows
      .map(
        (r) =>
          `<tr style="${KEEP}">${r.map((c, i) => `<td style="${S.td};${align(i)}">${c}</td>`).join('')}</tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

/** "Label : value" lines, as Bdjobs prints personal and career details. */
function pairs(items: [string, string | null][], labelWidth?: string): string {
  const shown = items.filter(([, v]) => v);
  if (!shown.length) return '';
  const label = labelWidth ? `${S.label};width:${labelWidth}` : S.label;
  return `<table style="width:100%;border-collapse:collapse;font-size:12px">${shown
    .map(
      ([k, v]) => `<tr style="${KEEP}">
        <td style="${label}">${esc(k)}</td>
        <td style="${S.colon}">:</td>
        <td style="${S.value}">${v}</td>
      </tr>`,
    )
    .join('')}</table>`;
}

const textSection = (title: string, body: string | null): string =>
  body ? section(title, `<p style="${S.body}">${body}</p>`) : '';

// --- sections ------------------------------------------------------------------

function jobBlock(j: CvEmployment, n: number, today: string): string {
  const span = jobYears(j, today);
  const from = dmy(j.from);
  const to = j.current ? 'Continuing' : dmy(j.to);
  const dates =
    from || to ? `(${[from ?? '?', to ?? '?'].join(' - ')} )` : null;
  const title = text(j.designation) ?? text(j.company) ?? '';
  return `<table style="width:100%;border-collapse:collapse;font-size:12px;${KEEP}"><tr>
    <td style="width:22px;vertical-align:top;padding:0 0 12px 4px">${n}.</td>
    <td style="vertical-align:top;padding:0 4px 12px 4px">
      <div style="${S.strong}">${esc(title)}${span ? ` <span style="font-weight:500;color:#4b515b">(${esc(span)})</span>` : ''}</div>
      ${dates ? `<div style="color:#4b515b">${esc(dates)}</div>` : ''}
      <div style="${S.strong};margin-top:4px">${esc(j.company)}</div>
      ${j.location ? `<div>${esc(j.location)}</div>` : ''}
      ${j.expertise ? `<div style="${S.sub}">Area of Expertise</div><div>${esc(j.expertise)}</div>` : ''}
      ${para(j.role) ? `<div style="${S.sub}">Duties/Responsibilities</div><div>${para(j.role)}</div>` : ''}
    </td>
  </tr></table>`;
}

/**
 * The band, the total and the first job travel together — a band alone at
 * the foot of a page is the very thing this layout avoids — and each later
 * job keeps itself whole.
 */
function experienceSection(p: CvProfile, today: string): string {
  const jobs = p.employment;
  const total =
    p.summary.statedExperienceYears ?? p.summary.totalExperienceYears;
  if (!jobs.length && !total) return '';
  const totalLine = total
    ? `<p style="${S.body};margin-bottom:10px"><span style="${S.strong}">Total Year of Experience:</span> ${esc(years(total))}</p>`
    : '';
  const [first, ...rest] = jobs;
  return `<section style="${S.section}">
    <div style="${S.band}">Experience</div>
    ${totalLine}
    ${first ? jobBlock(first, 1, today) : ''}
  </section>
  ${rest.map((j, i) => jobBlock(j, i + 2, today)).join('')}`;
}

function educationSection(p: CvProfile): string {
  if (!p.education.length) return '';
  return section(
    'Academic / Education',
    grid(
      [
        { head: 'Exam Title', width: '15%' },
        { head: 'Concentration/ Major', width: '14%' },
        { head: 'Institute', width: '22%' },
        { head: 'Result', width: '11%', align: 'center' },
        { head: 'Pas.Year', width: '9%', align: 'center' },
        { head: 'Duration', width: '9%', align: 'center' },
        { head: 'Achievement' },
      ],
      p.education.map((q) => [
        cell(q.degree),
        cell(q.major),
        `${cell(q.institute)}${
          q.university
            ? `<div style="color:#6b6f76;font-size:10.5px">${esc(q.university)}</div>`
            : ''
        }`,
        cell(q.result),
        cell(q.passYear),
        cell(q.duration),
        para(q.achievement) ?? '',
      ]),
    ),
  );
}

function trainingSection(p: CvProfile): string {
  if (!p.training?.length) return '';
  return section(
    'Training',
    grid(
      [
        { head: 'Training Title', width: '30%' },
        { head: 'Topic', width: '16%' },
        { head: 'Institute', width: '15%' },
        { head: 'Country', width: '11%', align: 'center' },
        { head: 'Location', width: '10%', align: 'center' },
        { head: 'Year', width: '7%', align: 'center' },
        { head: 'Duration', align: 'center' },
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
    ),
  );
}

function qualificationSection(p: CvProfile): string {
  if (!p.certifications?.length) return '';
  return section(
    'Professional Qualification',
    grid(
      [
        { head: 'Certification', width: '30%' },
        { head: 'Institute', width: '24%' },
        { head: 'Location', width: '14%', align: 'center' },
        { head: 'From', width: '16%', align: 'center' },
        { head: 'To', align: 'center' },
      ],
      p.certifications.map((c) => [
        cell(c.name),
        cell(c.institute),
        cell(c.location),
        cell(dmy(c.from)),
        cell(dmy(c.to)),
      ]),
    ),
  );
}

function careerSection(p: CvProfile): string {
  const c = p.career;
  const list = (v?: string[]) => (v?.length ? esc(v.join(', ')) : null);
  return section(
    'Career and Application Information',
    pairs([
      ['Preferred Job Category', list(c?.preferredJobCategories)],
      [
        'Looking For',
        text(c?.jobLevel) ? esc(text(c?.jobLevel) as string) : null,
      ],
      ['Present Salary', money(p.compensation.current)],
      ['Expected Salary', money(p.compensation.expected)],
      ['Preferred District', list(c?.preferredDistricts)],
      ['Preferred Organization Types', list(c?.preferredOrganizationTypes)],
    ]),
  );
}

/**
 * Skills as a three-column list when none is described — Bdjobs' two-column
 * table spent half the page on "No description provided". With
 * descriptions, the table.
 */
function skillSection(p: CvProfile): string {
  const skills = p.skills ?? [];
  if (!skills.length) return '';
  if (skills.some((s) => s.description)) {
    return section(
      'Skill',
      grid(
        [{ head: 'Fields of Skill', width: '36%' }, { head: 'Description' }],
        skills.map((s) => [esc(s.name), cell(s.description)]),
      ),
    );
  }
  const perColumn = Math.ceil(skills.length / 3);
  const columns = [0, 1, 2]
    .map((c) => skills.slice(c * perColumn, (c + 1) * perColumn))
    .filter((c) => c.length);
  return section(
    'Skill',
    `<table style="width:100%;border-collapse:collapse;font-size:12px"><tr>${columns
      .map(
        (col) =>
          `<td style="width:33.3%;vertical-align:top;padding:0 6px"><ul style="margin:0;padding-left:16px">${col
            .map((s) => `<li style="margin:0 0 4px">${esc(s.name)}</li>`)
            .join('')}</ul></td>`,
      )
      .join('')}</tr></table>`,
  );
}

function languageSection(p: CvProfile): string {
  if (!p.languages?.length) return '';
  return section(
    'Language Proficiency',
    `<div style="width:76%">${grid(
      [
        { head: 'Language', width: '28%' },
        { head: 'Reading', align: 'center' },
        { head: 'Writing', align: 'center' },
        { head: 'Speaking', align: 'center' },
      ],
      p.languages.map((l) => [
        cell(capital(text(l.language))),
        cell(l.reading),
        cell(l.writing),
        cell(l.speaking),
      ]),
    )}</div>`,
  );
}

function personalSection(p: CvProfile): string {
  const height = p.personal.heightMeters;
  const permanent = text(p.contact.permanentAddress);
  const current = text(p.contact.currentAddress);
  const v = (x: string | null | undefined) => (x ? esc(x) : null);
  return section(
    'Personal Details',
    pairs([
      ["Father's Name", v(text(p.personal.fatherName))],
      ["Mother's Name", v(text(p.personal.motherName))],
      ['Date of Birth', v(dmy(p.personal.dateOfBirth))],
      ['Gender', v(gender(p.personal.gender))],
      ['Marital Status', v(text(p.personal.maritalStatus))],
      ['Nationality', v(text(p.personal.nationality))],
      ['National Id No.', v(text(p.personal.nationalId))],
      ['Religion', v(text(p.personal.religion))],
      ['Blood Group', v(text(p.personal.bloodGroup)?.toUpperCase())],
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
    ]),
  );
}

function referenceBlock(r: CvReference): string {
  const v = (x: string | null | undefined) => (text(x) ? esc(text(x)!) : null);
  return pairs(
    [
      ['Name', esc(r.name)],
      ['Organization', v(r.organization)],
      ['Designation', v(r.designation)],
      ['Address', v(r.address)],
      ['Email', v(r.email)],
      ['Mobile', v(r.phone)],
      ['Relation', v(r.relation)],
    ],
    '34%',
  );
}

function referenceSection(p: CvProfile): string {
  const refs = p.references ?? [];
  if (!refs.length) return '';
  // Two to a row with a rule between them, as on Bdjobs' page.
  const rows: string[] = [];
  for (let i = 0; i < refs.length; i += 2) {
    const [a, b] = [refs[i], refs[i + 1]];
    rows.push(`<tr style="${KEEP}">
      <td style="width:50%;vertical-align:top;padding:0 12px 10px 0">${referenceBlock(a)}</td>
      <td style="width:50%;vertical-align:top;padding:0 0 10px 12px;border-left:1px solid #e3e5e8">${b ? referenceBlock(b) : ''}</td>
    </tr>`);
  }
  return section(
    'Reference',
    `<table style="width:100%;border-collapse:collapse">${rows.join('')}</table>`,
  );
}

function sourceLabel(p: CvProfile): string {
  return p.source === 'bdjobs'
    ? 'the BDJobs application'
    : p.source === 'upload'
      ? 'an uploaded document'
      : 'details entered by the recruiter';
}

/**
 * Render a CV.
 *
 * `now` is injectable so every span and the "generated on" line can be
 * asserted in a test rather than drifting with the clock. `print` leaves the
 * generated note out of the body: the PDF carries it in the page footer
 * (`cvPrintFooter`) instead.
 */
export function buildCvDocument(
  profile: CvProfile,
  now: Date = new Date(),
  /** The applicant's photo as a data: URI, when one was received. */
  photo?: string | null,
  opts: { print?: boolean } = {},
): string {
  const today = now.toISOString().slice(0, 10);
  const name = text(profile.personal.fullName) ?? 'Candidate name not supplied';
  const salutation = text(profile.personal.salutation);

  // Where they work now, under the name — the line a reader looks for first.
  const headline = profile.summary.currentlyEmployed
    ? [
        text(profile.summary.lastDesignation),
        text(profile.summary.lastOrganization),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

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
        <td style="width:22px;vertical-align:top;padding:0">${icon(k)}</td>
        <td style="vertical-align:top;padding:0">${esc(v as string)}</td>
      </tr></table>`,
    )
    .join('');

  // Only an inline image is ever embedded; see candidate-photo.ts.
  const photoTag =
    photo && /^data:image\/(jpeg|png|webp);base64,/.test(photo)
      ? `<img src="${photo}" alt="" style="${S.photo}">`
      : '';

  // The statements, in Bdjobs' order. A cover letter that only repeats one of
  // them is not printed twice.
  const objective = para(profile.careerObjective);
  const summary = para(profile.careerSummary);
  const special = para(profile.specialQualification);
  const cover = para(profile.coverLetter);
  const coverRepeats = [objective, summary, special].includes(cover);

  return `<div style="${S.page}">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:top;padding:4px 0 0 4px">
      <h1 style="${S.name}">${esc([salutation, name].filter(Boolean).join(' '))}</h1>
      ${headline ? `<p style="${S.headline}">${esc(headline)}</p>` : '<div style="height:12px"></div>'}
      ${contactRows}
    </td>
    ${photoTag ? `<td style="vertical-align:top;width:122px;padding:0 2px 0 16px">${photoTag}</td>` : ''}
  </tr></table>
  <hr style="${S.rule}" />
  ${textSection('Career Objective', objective)}
  ${textSection('Career Summary', summary)}
  ${textSection('Special Qualification', special)}
  ${coverRepeats ? '' : textSection('Cover Letter', cover)}
  ${experienceSection(profile, today)}
  ${educationSection(profile)}
  ${trainingSection(profile)}
  ${qualificationSection(profile)}
  ${careerSection(profile)}
  ${skillSection(profile)}
  ${languageSection(profile)}
  ${personalSection(profile)}
  ${referenceSection(profile)}
  ${
    opts.print
      ? ''
      : `<p style="${S.footer}">
    Generated by DBL HRM from ${esc(sourceLabel(profile))} on ${esc(longDate(now))} — a formatted record of the details the candidate submitted, not a CV
    they wrote; anything missing was not asked for, rather than left out.
  </p>`
  }
</div>`;
}

/** The same CV as a whole page, for a browser tab or the PDF printer. */
export function buildCvPage(
  profile: CvProfile,
  now: Date = new Date(),
  photo?: string | null,
  opts: { print?: boolean } = {},
): string {
  const title = `${text(profile.personal.fullName) ?? 'Candidate'} — CV`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#fff">${buildCvDocument(profile, now, photo, opts)}</body></html>`;
}

/**
 * The PDF's page footer: the generated note on the left, "Page 2 of 3" on
 * the right, on every page. Chrome fills `pageNumber` / `totalPages`, and a
 * footer template has no stylesheet, so everything is inline.
 */
export function cvPrintFooter(
  profile: CvProfile,
  now: Date = new Date(),
): string {
  return `<div style="width:100%;padding:0 14mm;font-family:Arial,Helvetica,sans-serif;font-size:8px;color:#8f959e;display:flex;justify-content:space-between;align-items:flex-end;gap:12px">
  <span>Generated by DBL HRM from ${esc(sourceLabel(profile))} on ${esc(longDate(now))} — a formatted record of what the candidate submitted, not a CV they wrote.</span>
  <span style="white-space:nowrap">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
}
