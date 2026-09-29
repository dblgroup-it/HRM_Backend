/**
 * The one line under a candidate's name: latest title, company, years.
 *
 * It is the first thing a recruiter compares down a list, and every CV that
 * has been read already carries it in `summary` — the AI read of an uploaded
 * PDF and the BDJobs mapper both fill `lastDesignation`, `lastOrganization`
 * and the experience figures. This only picks them out, so the row and the
 * interviewer's sheet can never disagree about somebody's experience.
 *
 * Null when the CV has not been read, or says none of the three.
 */
export interface CvHeadline {
  title: string | null;
  company: string | null;
  /** Years of experience, overlapping jobs counted once; the CV's own claim when that is all there is. */
  years: number | null;
  /** Still in that job. */
  current: boolean;
}

const text = (v: unknown): string | null => {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return t ? t : null;
};

const positive = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

export function cvHeadline(profile: unknown): CvHeadline | null {
  if (!profile || typeof profile !== 'object') return null;
  const summary = (profile as { summary?: Record<string, unknown> }).summary;
  if (!summary || typeof summary !== 'object') return null;

  const title = text(summary.lastDesignation);
  const company = text(summary.lastOrganization);
  const years =
    positive(summary.totalExperienceYears) ?? positive(summary.statedExperienceYears);
  if (!title && !company && years === null) return null;

  return {
    title,
    company,
    years: years === null ? null : Math.round(years * 10) / 10,
    current: summary.currentlyEmployed === true,
  };
}
