import type { ExtractedCv } from '../../integrations/ai/ai-grader.service';
import type { CvEmployment, CvProfile } from './cv-profile.types';

const clean = (v?: string | null): string | undefined => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
};

/** yyyy-mm-dd, or undefined when the model returned something unusable. */
function isoDay(value?: string | null): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // "2019" alone — the sheet's convention is January of that year.
  const year = /^(19|20)\d{2}$/.exec(raw);
  return year ? `${raw}-01-01` : undefined;
}

const monthsBetween = (from: string, to: string): number => {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return (
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
  );
};

/**
 * Total service with overlapping jobs counted once.
 *
 * The same merge `bdjobsToCvProfile` does, and for the same reason: a CV
 * that lists two concurrent roles at one group would otherwise be credited
 * with both spans, and the figure is printed on a sheet the board reads.
 */
function mergedMonths(jobs: CvEmployment[], today: string): number {
  const spans = jobs
    .map((j) => ({ from: j.from, to: j.to && j.to <= today ? j.to : today }))
    .filter((s): s is { from: string; to: string } => Boolean(s.from))
    .filter((s) => s.from <= s.to)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!spans.length) return 0;

  const merged: { from: string; to: string }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) {
      if (span.to > last.to) last.to = span.to;
    } else {
      merged.push({ ...span });
    }
  }
  return merged.reduce((n, s) => n + Math.max(0, monthsBetween(s.from, s.to)), 0);
}

/** "6 years 4 months", "8 months" — how the sheet prints it. */
function experienceLabel(totalMonths: number): string | undefined {
  if (totalMonths <= 0) return undefined;
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const parts: string[] = [];
  if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (months) parts.push(`${months} month${months === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** A date of birth implied by a stated age, when the CV gave only the age. */
function dobFromAge(age?: number): string | undefined {
  if (!age || age < 15 || age > 80) return undefined;
  const year = new Date().getFullYear() - age;
  // Mid-year, so the derived age is right either side of a birthday. It is
  // an approximation and only ever used to show an age, never a birthday.
  return `${year}-07-01`;
}

/**
 * What the AI read off a CV, in the system's own `CvProfile` shape.
 *
 * Everything downstream — the shortlisting sheet's columns, the screening
 * panel, the interviewer's summary — reads `CvProfile` and nothing else. A
 * candidate who applied on the careers page arrives as a PDF with no profile
 * at all, which is why their interviewer's summary came up empty; this is the
 * bridge, and it deliberately produces exactly the same shape rather than a
 * second one to learn.
 *
 * `source: 'upload'` records where it came from, so a stale extraction can be
 * traced or re-run.
 */
export function extractedCvToProfile(extracted: ExtractedCv): CvProfile {
  const today = new Date().toISOString().slice(0, 10);

  const employment: CvEmployment[] = extracted.employment
    .map((job) => {
      const from = isoDay(job.from);
      const to = isoDay(job.to);
      return {
        company: clean(job.company) ?? '',
        designation: clean(job.designation),
        from,
        to: job.current ? undefined : to,
        current: Boolean(job.current) || (!to && Boolean(from)),
      };
    })
    .filter((job) => job.company);

  const education = extracted.education
    .map((e) => ({
      institute: clean(e.institute) ?? clean(e.degree) ?? '',
      degree: clean(e.degree),
      passYear: e.year,
      result: clean(e.result),
    }))
    .filter((e) => e.institute || e.degree);

  const months = mergedMonths(employment, today);
  const latest = education.find((e) => e.degree || e.institute);
  const current = employment.find((j) => j.current) ?? employment[0];

  return {
    source: 'upload',
    capturedAt: new Date().toISOString(),
    personal: {
      fullName: clean(extracted.fullName) ?? '',
      // A stated date of birth wins; an age alone is enough to show an age.
      dateOfBirth: isoDay(extracted.dateOfBirth) ?? dobFromAge(extracted.age),
    },
    contact: {
      email: clean(extracted.email),
      phone: clean(extracted.phone),
      currentAddress: clean(extracted.address),
    },
    employment,
    education,
    compensation: {},
    summary: {
      latestEducation: latest
        ? [latest.degree, latest.institute, latest.passYear]
            .filter(Boolean)
            .join(' · ')
        : undefined,
      totalExperienceYears: months > 0 ? Math.round((months / 12) * 10) / 10 : undefined,
      // What the CV itself claims wins over the computed figure: a CV saying
      // "22 years" is a claim the interviewer can put to them, where a
      // derived number invites an argument about our arithmetic.
      totalExperienceLabel:
        clean(extracted.totalExperienceLabel) ?? experienceLabel(months),
      lastOrganization: current?.company,
      lastDesignation: current?.designation,
      currentlyEmployed: employment.some((j) => j.current),
    },
  };
}
