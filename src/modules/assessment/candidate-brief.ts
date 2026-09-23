import type {
  CvEducation,
  CvEmployment,
  CvProfile,
} from '../candidates/cv/cv-profile.types';

/**
 * The candidate, as an interviewer needs to read them in the room.
 *
 * The same block DBL's own shortlisting sheet prints: who they are and how to
 * reach them, how old they are, what they studied, every post they have held
 * with the company and the span, and the total service at the end. An
 * interviewer marking someone on "relevant experience" is scoring exactly
 * these facts, and the CV is a PDF in another tab — so the facts travel with
 * the evaluation form.
 *
 * Built from the stored `CvProfile` where there is one. Read defensively:
 * the column is JSON written by whichever version of the mapper was running
 * when the CV arrived, and a candidate typed in by hand has none at all.
 */
export interface CandidateBrief {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** Whole years, from the date of birth the CV stated. */
  age: number | null;
  education: CandidateBriefEducation[];
  employment: CandidateBriefJob[];
  /**
   * The same jobs grouped by company, as the shortlisting sheet prints them:
   * "SQ Group of Companies : (7.1 Yrs. Total)" over each post held there.
   */
  companies: CandidateBriefCompany[];
  /**
   * "22 years", the way the shortlisting sheet prints it. Taken from the CV's
   * own summary when it states one, otherwise added up from the job dates
   * (overlaps counted once) — a CV without a summary line still has dates.
   */
  totalService: string | null;
  /** True when nothing below the name could be filled in. */
  empty: boolean;
}

export interface CandidateBriefEducation {
  /** "MBA (Global with Commendation)" — or the institute, if that is all. */
  degree: string;
  /** "University of Bedfordshire, UK" */
  institute: string | null;
  year: number | null;
  result: string | null;
  /**
   * A qualification or a course.
   *
   * DBL's own shortlisting sheet prints these as two blocks — "Education"
   * and "Professional Certifications" — because they are read differently:
   * one says what somebody is qualified as, the other what they have kept
   * up with. A CV lists them together, so they are separated here.
   */
  kind: 'degree' | 'certification';
}

export interface CandidateBriefJob {
  company: string;
  designation: string | null;
  /** "Jan 2025 – Present" */
  period: string | null;
  /** "1.7 Yrs." */
  duration: string | null;
  current: boolean;
}

export interface CandidateBriefCompany {
  company: string;
  /** "7.1 Yrs." — every post there, overlaps counted once. */
  total: string | null;
  roles: CandidateBriefJob[];
}

/** The candidate columns this needs; anything that has them can be passed. */
export interface CandidateBriefSource {
  name: string;
  email?: string | null;
  phone?: string | null;
  cvAddress?: string | null;
  cvProfile?: unknown;
}

const clean = (v: unknown): string | null => {
  const t = String(v ?? '')
    // Bdjobs pads free text with backticks; the mapper tidies what it writes,
    // but older rows were stored before it did.
    .replace(/[`´]+/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t : null;
};

/**
 * "10 Oct 2023", or "Oct 2023" when the source only knew the month — ISO in,
 * human out. A first-of-the-month is how a month-only date is stored, so the
 * day is left off rather than printing a "1" nobody wrote. Null rather than
 * "Invalid Date".
 */
function monthYear(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', {
    ...(d.getUTCDate() === 1 ? {} : { day: 'numeric' }),
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const monthsBetween = (a: Date, b: Date): number =>
  (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());

/** Months across these spans, overlapping stretches counted once. */
function mergedMonths(spans: { from?: string | null; to?: string | null }[]): number {
  const now = new Date();
  const ranges = spans
    .map((s) => ({ a: s.from ? new Date(s.from) : null, b: s.to ? new Date(s.to) : now }))
    .filter(
      (r): r is { a: Date; b: Date } =>
        r.a !== null && !Number.isNaN(r.a.getTime()) && !Number.isNaN(r.b.getTime()) && r.a <= r.b,
    )
    .map((r) => ({ a: r.a, b: r.b > now ? now : r.b }))
    .sort((x, y) => x.a.getTime() - y.a.getTime());
  const merged: { a: Date; b: Date }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.a <= last.b) {
      if (r.b > last.b) last.b = r.b;
    } else merged.push({ ...r });
  }
  return merged.reduce((n, r) => n + Math.max(0, monthsBetween(r.a, r.b)), 0);
}

/** "1.7 Yrs." / "1.0 Yr" / "8 Mos." from a month count. */
function monthsLabel(months: number): string | null {
  if (months <= 0) return null;
  if (months < 12) return `${months} Mo${months === 1 ? '' : 's'}.`;
  const years = (months / 12).toFixed(1);
  return years === '1.0' ? '1.0 Yr' : `${years} Yrs.`;
}

/** "22 years" / "6 years 4 months" — the total, as the sheet prints it. */
function serviceLabel(months: number): string | null {
  if (months <= 0) return null;
  const y = Math.floor(months / 12);
  const m = months % 12;
  const parts = [
    y ? `${y} year${y === 1 ? '' : 's'}` : null,
    m ? `${m} month${m === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

/** "1.7 Yrs." / "8 Mos." — one span, the way the sheet writes it. */
function spanLabel(from?: string | null, to?: string | null): string | null {
  if (!from) return null;
  return monthsLabel(mergedMonths([{ from, to }]));
}

/** Whole years, today. Null for a missing or unreadable date of birth. */
function ageFrom(dateOfBirth?: string | null): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const before =
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  if (before) age -= 1;
  return age > 0 && age < 100 ? age : null;
}

/**
 * Degree or course?
 *
 * Matched on the award, which is the only thing that reliably distinguishes
 * them — an institute name says nothing ("Skillful Bangladesh" awards a
 * course, a university awards both). Anything unrecognised is treated as a
 * certification: over-promoting a two-day workshop to "Education" misleads,
 * where under-promoting a degree merely files it one block lower.
 */
const DEGREE_PATTERN = new RegExp(
  [
    // School-leaving, as Bangladesh writes it — spelled out as well as
    // abbreviated, because a CV does both ("HSC", "Higher Secondary School
    // Certificate") and the spelled-out form was being filed as a course.
    '\\b(?:ssc|hsc|dakhil|alim|o[ -]levels?|a[ -]levels?)\\b',
    // Dotted, as certificates print them: "(H.S.C)", "S.S.C."
    '\\b[hs]\\.\\s?s\\.\\s?c\\b',
    // "Higher Secondary Certificate" drops the "School" as often as not.
    '(?:higher )?secondary (?:school )?certificate',
    // Plurals matter: `\\bmaster\\b` does not match "Masters Of Science".
    '\\b(?:bachelors?|masters?|doctorate|honou?rs|diploma|mphil|phd)\\b',
    '\\bb\\.?\\s?(?:sc|a|com|ba|eng|tech)\\b',
    '\\bm\\.?\\s?(?:sc|a|com|ba|eng|tech)\\b',
    '\\b(?:bba|mba|beng|meng|llb|llm|mbbs|bds|ph\\.?\\s?d)\\b',
  ].join('|'),
  'i',
);

function educationRow(e: CvEducation): CandidateBriefEducation | null {
  const degree = clean(e.degree);
  const institute =
    clean(e.institute) === clean(e.university)
      ? clean(e.institute)
      : [clean(e.institute), clean(e.university)].filter(Boolean).join(', ') ||
        null;
  if (!degree && !institute) return null;
  return {
    degree: degree ?? institute ?? '',
    institute: degree ? institute : null,
    year: typeof e.passYear === 'number' ? e.passYear : null,
    result: clean(e.result),
    kind: DEGREE_PATTERN.test(degree ?? '') ? 'degree' : 'certification',
  };
}

function jobRow(j: CvEmployment): CandidateBriefJob | null {
  const company = clean(j.company);
  if (!company) return null;
  const from = monthYear(j.from);
  const to = j.current ? 'Present' : monthYear(j.to);
  return {
    company,
    designation: clean(j.designation),
    period: from || to ? `${from ?? '?'} – ${to ?? '?'}` : null,
    duration: spanLabel(j.from, j.current ? null : j.to),
    current: Boolean(j.current),
  };
}

/** The stored JSON, if it is a CV profile at all. */
function readProfile(value: unknown): CvProfile | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Partial<CvProfile>;
  return p.personal || p.employment || p.education ? (p as CvProfile) : null;
}

export function buildCandidateBrief(
  candidate: CandidateBriefSource,
): CandidateBrief {
  const profile = readProfile(candidate.cvProfile);
  const contact = profile?.contact ?? {};
  const personal = profile?.personal;
  const summary = profile?.summary;

  const education = (profile?.education ?? [])
    .map(educationRow)
    .filter((row): row is CandidateBriefEducation => row !== null)
    // Most recent first: the qualification that matters is the latest one,
    // and sources disagree about the order they send them in.
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  const jobs = (profile?.employment ?? []).filter((j) => clean(j.company));
  const employment = jobs
    .map(jobRow)
    .filter((row): row is CandidateBriefJob => row !== null);

  // Grouped by company in the order the CV lists them (latest first, as CVs
  // are written), matching names case- and punctuation-insensitively.
  const key = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const groups = new Map<string, { company: string; src: CvEmployment[]; roles: CandidateBriefJob[] }>();
  jobs.forEach((j, i) => {
    const k = key(clean(j.company)!);
    const g = groups.get(k) ?? { company: clean(j.company)!, src: [], roles: [] };
    g.src.push(j);
    g.roles.push(employment[i]);
    groups.set(k, g);
  });
  const companies: CandidateBriefCompany[] = [...groups.values()].map((g) => ({
    company: g.company,
    total: monthsLabel(
      mergedMonths(g.src.map((j) => ({ from: j.from, to: j.current ? null : j.to }))),
    ),
    roles: g.roles,
  }));
  const computedService = serviceLabel(
    mergedMonths(jobs.map((j) => ({ from: j.from, to: j.current ? null : j.to }))),
  );

  const brief: CandidateBrief = {
    name: candidate.name,
    phone: clean(candidate.phone) ?? clean(contact.phone),
    email: clean(candidate.email) ?? clean(contact.email),
    address:
      clean(candidate.cvAddress) ??
      clean(contact.currentAddress) ??
      clean(contact.currentLocation) ??
      clean(contact.permanentAddress),
    age: ageFrom(personal?.dateOfBirth),
    education,
    employment,
    companies,
    totalService: clean(summary?.totalExperienceLabel) ?? computedService,
    empty: false,
  };
  brief.empty =
    !brief.phone &&
    !brief.email &&
    !brief.address &&
    brief.age === null &&
    !brief.totalService &&
    education.length === 0 &&
    employment.length === 0;
  return brief;
}
