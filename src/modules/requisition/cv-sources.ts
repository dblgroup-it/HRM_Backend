/**
 * Where Head of Talent Acquisition sources CVs for a requisition.
 *
 * Ticked before a recruiter is assigned, so the recruiter is handed a brief
 * that says where to look. Decorator-free so a test can import it; the
 * frontend mirrors the keys in `requisition/constants.ts` (CV_SOURCES).
 */
export const CV_SOURCES = [
  'linkedin',
  'bdjobs',
  'head_hunting',
  'social_media',
  'career_site',
  'campus',
  'internal_posting',
  'cv_bank',
  'talent_pool',
] as const;

export type CvSource = (typeof CV_SOURCES)[number];

export const CV_SOURCE_LABEL: Record<CvSource, string> = {
  linkedin: 'LinkedIn',
  bdjobs: 'BDJobs',
  head_hunting: 'Head Hunting',
  social_media: 'Social media',
  career_site: 'Career Site',
  campus: 'Campus',
  internal_posting: 'Internal Posting',
  cv_bank: 'CV Bank',
  talent_pool: 'Talent Pool',
};

/** De-duplicated, in catalogue order — so the stored list never depends on
 * the order the boxes happened to be ticked in. */
export function normaliseCvSources(input: readonly string[]): CvSource[] {
  const picked = new Set(input);
  return CV_SOURCES.filter((s) => picked.has(s));
}
