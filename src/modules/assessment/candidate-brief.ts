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
  /** "22 years", the way the shortlisting sheet prints it. */
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

/** "Jan 2025" — ISO in, human out. Null rather than "Invalid Date". */
function monthYear(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

/** "1.7 Yrs." / "8 Mos." — one span, the way the sheet writes it. */
function spanLabel(from?: string | null, to?: string | null): string | null {
  if (!from) return null;
  const a = new Date(from);
  const b = to ? new Date(to) : new Date();
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const months =
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (months <= 0) return null;
  if (months < 12) return `${months} Mo${months === 1 ? '' : 's'}.`;
  return `${(months / 12).toFixed(1)} Yrs.`;
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

  const employment = (profile?.employment ?? [])
    .map(jobRow)
    .filter((row): row is CandidateBriefJob => row !== null);

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
    totalService: clean(summary?.totalExperienceLabel),
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
