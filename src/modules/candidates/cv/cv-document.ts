import type {
  CvCertification,
  CvEducation,
  CvEmployment,
  CvLanguage,
  CvProfile,
  CvReference,
  CvSkill,
  CvTraining,
} from './cv-profile.types';

/**
 * A printable CV built from structured data, for candidates who never sent a file.
 *
 * Bdjobs applications arrive as fields, not documents — there is no CV to open,
 * download or hand to an interviewer. Everything needed is already in
 * `CvProfile`; this renders it as the document it should have been.
 *
 * Inline styles throughout, and no external assets: this is opened in a new
 * tab, printed, and pasted into mail, and every one of those strips a
 * stylesheet. Same reasoning as the offer letters.
 *
 * It is deliberately labelled as generated. An interviewer who believes they
 * are reading a CV the candidate wrote will read omissions as choices the
 * candidate made, and these omissions are Bdjobs' form design.
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

const text = (v: string | undefined | null): string | null => {
  const t = (v ?? '').trim();
  return t ? tidy(t) : null;
};

/** "Mar 2011" — ISO in, human out. Returns null rather than "Invalid Date". */
function monthYear(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

/** "Mar 2011 – Present" for a job still running. */
function period(job: CvEmployment): string {
  const from = monthYear(job.from);
  const to = job.current ? 'Present' : monthYear(job.to);
  if (!from && !to) return '—';
  return [from ?? '?', to ?? '?'].join(' – ');
}

/** "6 yrs 4 mos" for one role, so a reader can weigh it at a glance. */
function span(job: CvEmployment, today: string): string | null {
  if (!job.from) return null;
  const end = job.to && job.to <= today ? job.to : today;
  const a = new Date(job.from);
  const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const months =
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (months <= 0) return null;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [
    y ? `${y} yr${y === 1 ? '' : 's'}` : null,
    m ? `${m} mo${m === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

const S = {
  page: 'font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:0 auto;padding:32px 40px;color:#1f2937;background:#fff',
  name: 'margin:0;font-size:24px;line-height:1.2;font-weight:700;color:#0f172a',
  contact: 'margin:6px 0 0;font-size:13px;color:#475569',
  rule: 'border:0;border-top:2px solid #1877c0;margin:16px 0 0',
  h2: 'margin:26px 0 10px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#1877c0',
  table: 'width:100%;border-collapse:collapse;font-size:13px',
  th: 'text-align:left;padding:6px 8px;background:#f1f5f9;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e2e8f0',
  td: 'padding:7px 8px;border-bottom:1px solid #eef2f7;vertical-align:top',
  muted: 'color:#64748b',
  factLabel:
    'font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b',
  factValue: 'font-size:14px;font-weight:600;color:#0f172a',
  footer:
    'margin:28px 0 0;padding-top:12px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;line-height:1.6',
};

function factCell(label: string, value: string): string {
  return `<td style="${S.td};border-bottom:0;width:25%">
      <div style="${S.factLabel}">${esc(label)}</div>
      <div style="${S.factValue}">${esc(value)}</div>
    </td>`;
}

function employmentSection(jobs: CvEmployment[], today: string): string {
  if (!jobs.length) return '';
  const rows = jobs
    .map((j) => {
      const duration = span(j, today);
      return `<tr>
        <td style="${S.td};width:26%">${esc(period(j))}${
          duration
            ? `<div style="${S.muted};font-size:11px;margin-top:2px">${esc(duration)}</div>`
            : ''
        }</td>
        <td style="${S.td}"><strong>${esc(j.company)}</strong>${
          j.location
            ? `<div style="${S.muted};font-size:11px">${esc(j.location)}</div>`
            : ''
        }${
          j.current
            ? ' <span style="font-size:10px;color:#1877c0;font-weight:700">CURRENT</span>'
            : ''
        }</td>
        <td style="${S.td}">${esc(j.designation ?? '—')}${
          j.expertise
            ? `<div style="font-size:11px;margin-top:2px"><span style="${S.muted}">Expertise:</span> ${esc(j.expertise)}</div>`
            : ''
        }${
          j.role
            ? `<div style="${S.muted};font-size:11px;margin-top:2px">${esc(j.role)}</div>`
            : ''
        }</td>
      </tr>`;
    })
    .join('');
  return `<h2 style="${S.h2}">Professional Experience</h2>
  <table style="${S.table}">
    <tr><th style="${S.th}">Period</th><th style="${S.th}">Organization</th><th style="${S.th}">Designation</th></tr>
    ${rows}
  </table>`;
}

function educationSection(quals: CvEducation[]): string {
  if (!quals.length) return '';
  const rows = quals
    .map(
      (q) => `<tr>
        <td style="${S.td};width:16%">${esc(q.passYear ? String(q.passYear) : '—')}</td>
        <td style="${S.td}"><strong>${esc(q.institute)}</strong>${
          q.university && q.university !== q.institute
            ? `<div style="${S.muted};font-size:11px">${esc(q.university)}</div>`
            : ''
        }</td>
        <td style="${S.td}">${esc(q.degree ?? '—')}${
          q.major
            ? `<div style="${S.muted};font-size:11px">${esc(q.major)}</div>`
            : ''
        }${
          q.duration
            ? `<div style="${S.muted};font-size:11px">Duration: ${esc(q.duration)}</div>`
            : ''
        }${
          q.achievement
            ? `<div style="${S.muted};font-size:11px">Achievement: ${esc(q.achievement)}</div>`
            : ''
        }</td>
        <td style="${S.td};width:16%">${esc(q.result ?? '—')}</td>
      </tr>`,
    )
    .join('');
  return `<h2 style="${S.h2}">Education</h2>
  <table style="${S.table}">
    <tr><th style="${S.th}">Year</th><th style="${S.th}">Institute</th><th style="${S.th}">Degree</th><th style="${S.th}">Result</th></tr>
    ${rows}
  </table>`;
}

function personalSection(p: CvProfile): string {
  const items: [string, string | null][] = [
    ["Father's name", text(p.personal.fatherName)],
    ["Mother's name", text(p.personal.motherName)],
    [
      'Date of birth',
      monthYear(p.personal.dateOfBirth) ? text(p.personal.dateOfBirth) : null,
    ],
    ['Gender', text(p.personal.gender)],
    ['Marital status', text(p.personal.maritalStatus)],
    ['Blood group', text(p.personal.bloodGroup)],
    ['Religion', text(p.personal.religion)],
    ['Nationality', text(p.personal.nationality)],
    [
      'Height / weight',
      [
        p.personal.heightMeters ? `${p.personal.heightMeters} m` : null,
        p.personal.weightKg ? `${p.personal.weightKg} kg` : null,
      ]
        .filter(Boolean)
        .join(' / ') || null,
    ],
    ['Present address', text(p.contact.currentAddress)],
    ['Permanent address', text(p.contact.permanentAddress)],
  ];
  const rows = items
    .filter(([, v]) => v)
    .map(
      ([k, v]) => `<tr>
        <td style="${S.td};width:28%;${S.muted}">${esc(k)}</td>
        <td style="${S.td}">${esc(v as string)}</td>
      </tr>`,
    )
    .join('');
  if (!rows) return '';
  return `<h2 style="${S.h2}">Personal Details</h2>
  <table style="${S.table}">${rows}</table>`;
}

function table(head: string[], rows: string[][], widths: string[] = []): string {
  return `<table style="${S.table}">
    <tr>${head.map((h, i) => `<th style="${S.th}${widths[i] ? `;width:${widths[i]}` : ''}">${esc(h)}</th>`).join('')}</tr>
    ${rows
      .map((r) => `<tr>${r.map((c) => `<td style="${S.td}">${c}</td>`).join('')}</tr>`)
      .join('')}
  </table>`;
}

const cell = (v?: string | number | null): string =>
  v === undefined || v === null || v === '' ? '—' : esc(String(v));

function trainingSection(rows: CvTraining[] = []): string {
  if (!rows.length) return '';
  return `<h2 style="${S.h2}">Training</h2>
  ${table(
    ['Year', 'Training', 'Institute', 'Duration'],
    rows.map((t) => [
      cell(t.year),
      `<strong>${esc(t.title)}</strong>${t.topic ? `<div style="${S.muted};font-size:11px">${esc(t.topic)}</div>` : ''}`,
      `${cell(t.institute)}${
        t.location || t.country
          ? `<div style="${S.muted};font-size:11px">${esc([t.location, t.country].filter(Boolean).join(', '))}</div>`
          : ''
      }`,
      cell(t.duration),
    ]),
    ['12%', '', '', '16%'],
  )}`;
}

function certificationSection(rows: CvCertification[] = []): string {
  if (!rows.length) return '';
  return `<h2 style="${S.h2}">Professional Certifications</h2>
  ${table(
    ['Certification', 'Institute', 'Period'],
    rows.map((c) => [
      `<strong>${esc(c.name)}</strong>`,
      `${cell(c.institute)}${c.location ? `<div style="${S.muted};font-size:11px">${esc(c.location)}</div>` : ''}`,
      cell([monthYear(c.from), monthYear(c.to)].filter(Boolean).join(' – ')),
    ]),
    ['', '', '24%'],
  )}`;
}

function careerSection(p: CvProfile): string {
  const c = p.career;
  const items: [string, string | null][] = [
    ['Preferred job category', c?.preferredJobCategories?.join(', ') ?? null],
    ['Looking for (job level)', text(c?.jobLevel)],
    [
      'Present salary',
      p.compensation.current ? p.compensation.current.toLocaleString('en-US') : null,
    ],
    [
      'Expected salary',
      p.compensation.expected ? p.compensation.expected.toLocaleString('en-US') : null,
    ],
    ['Preferred district', c?.preferredDistricts?.join(', ') ?? null],
    ['Preferred organization type', c?.preferredOrganizationTypes?.join(', ') ?? null],
  ];
  const rows = items.filter(([, v]) => v);
  if (!rows.length) return '';
  return `<h2 style="${S.h2}">Career and Application</h2>
  <table style="${S.table}">${rows
    .map(
      ([k, v]) => `<tr><td style="${S.td};width:28%;${S.muted}">${esc(k)}</td><td style="${S.td}">${esc(v as string)}</td></tr>`,
    )
    .join('')}</table>`;
}

function skillsSection(rows: CvSkill[] = []): string {
  if (!rows.length) return '';
  const described = rows.some((r) => r.description);
  if (!described)
    return `<h2 style="${S.h2}">Skills</h2>
  <p style="margin:0;font-size:13px;line-height:1.8">${rows
    .map(
      (r) =>
        `<span style="display:inline-block;margin:0 6px 6px 0;padding:2px 10px;border:1px solid #cbd5e1;border-radius:999px">${esc(r.name)}</span>`,
    )
    .join('')}</p>`;
  return `<h2 style="${S.h2}">Skills</h2>
  ${table(
    ['Skill', 'Description'],
    rows.map((r) => [`<strong>${esc(r.name)}</strong>`, cell(r.description)]),
    ['32%', ''],
  )}`;
}

function languageSection(rows: CvLanguage[] = []): string {
  if (!rows.length) return '';
  return `<h2 style="${S.h2}">Languages</h2>
  ${table(
    ['Language', 'Reading', 'Writing', 'Speaking'],
    rows.map((l) => [`<strong>${esc(l.language)}</strong>`, cell(l.reading), cell(l.writing), cell(l.speaking)]),
  )}`;
}

function referenceSection(rows: CvReference[] = []): string {
  if (!rows.length) return '';
  return `<h2 style="${S.h2}">References</h2>
  ${table(
    ['Name', 'Organization', 'Relation', 'Contact'],
    rows.map((r) => [
      `<strong>${esc(r.name)}</strong>${r.designation ? `<div style="${S.muted};font-size:11px">${esc(r.designation)}</div>` : ''}`,
      cell(r.organization),
      cell(r.relation),
      [r.email, r.phone].filter(Boolean).map((x) => esc(x as string)).join('<br>') || '—',
    ]),
  )}`;
}

/**
 * Render a CV.
 *
 * `now` is injectable so the "generated on" line and every duration can be
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

  const contact = [
    text(profile.contact.email),
    text(profile.contact.phone),
    text(profile.contact.currentLocation),
  ]
    .filter(Boolean)
    .map((v) => esc(v as string))
    .join(' &nbsp;·&nbsp; ');
  const links = [
    profile.contact.linkedinUrl
      ? `<a href="${esc(profile.contact.linkedinUrl)}" style="color:#1877c0">LinkedIn</a>`
      : null,
    profile.contact.facebookUrl
      ? `<a href="${esc(profile.contact.facebookUrl)}" style="color:#1877c0">Facebook</a>`
      : null,
  ].filter(Boolean);
  // Only an inline image is ever embedded; see candidate-photo.ts.
  const photoTag =
    photo && /^data:image\/(jpeg|png|webp);base64,/.test(photo)
      ? `<img src="${photo}" alt="" style="width:96px;height:118px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;display:block">`
      : '';

  // The four things a recruiter looks for before reading anything else.
  const facts: [string, string][] = [];
  if (profile.summary.totalExperienceLabel)
    facts.push(['Total experience', profile.summary.totalExperienceLabel]);
  if (profile.summary.lastOrganization)
    facts.push([
      profile.summary.currentlyEmployed ? 'Currently at' : 'Last organization',
      [profile.summary.lastOrganization, profile.summary.lastDesignation]
        .filter(Boolean)
        .join(' — '),
    ]);
  if (profile.summary.latestEducation)
    facts.push(['Latest education', profile.summary.latestEducation]);
  if (profile.compensation.expected)
    facts.push([
      'Expected salary',
      profile.compensation.expected.toLocaleString('en-US'),
    ]);
  else if (profile.compensation.current)
    facts.push([
      'Current salary',
      profile.compensation.current.toLocaleString('en-US'),
    ]);

  const factRow = facts.length
    ? `<table style="${S.table};margin-top:14px;background:#f8fafc;border-radius:6px">
        <tr>${facts.map(([k, v]) => factCell(k, v)).join('')}</tr>
      </table>`
    : '';

  const sourceLabel =
    profile.source === 'bdjobs'
      ? 'the BDJobs application'
      : profile.source === 'upload'
        ? 'an uploaded document'
        : 'details entered by the recruiter';

  const objective = text(profile.careerObjective);

  return `<div style="${S.page}">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:top">
      <h1 style="${S.name}">${esc([salutation, name].filter(Boolean).join(' '))}</h1>
      ${contact ? `<p style="${S.contact}">${contact}</p>` : ''}
      ${links.length ? `<p style="${S.contact}">${links.join(' &nbsp;·&nbsp; ')}</p>` : ''}
    </td>
    ${photoTag ? `<td style="vertical-align:top;width:96px;padding-left:16px">${photoTag}</td>` : ''}
  </tr></table>
  <hr style="${S.rule}" />
  ${factRow}
  ${objective ? `<h2 style="${S.h2}">Career Objective</h2><p style="margin:0;font-size:13px;line-height:1.6">${esc(objective)}</p>` : ''}
  ${employmentSection(profile.employment, today)}
  ${educationSection(profile.education)}
  ${trainingSection(profile.training)}
  ${certificationSection(profile.certifications)}
  ${careerSection(profile)}
  ${skillsSection(profile.skills)}
  ${languageSection(profile.languages)}
  ${personalSection(profile)}
  ${referenceSection(profile.references)}
  <p style="${S.footer}">
    Generated by DBL HRM from ${esc(sourceLabel)} on ${esc(
      now.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    )}.
    This is a formatted record of the details the candidate submitted, not a CV
    they wrote — anything missing was not asked for, rather than left out.
  </p>
</div>`;
}
