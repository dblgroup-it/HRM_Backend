import type { CvProfile } from '../../candidates/cv/cv-profile.types';

/**
 * What happens when BDJobs sends an application we already have.
 *
 * It used to be ignored ("duplicate — nothing was changed"), which left no
 * way to repair a CV once our mapping had dropped part of it: the payload was
 * never kept, and the one copy of it was on BDJobs' side. Now a resend
 * refreshes what came from BDJobs — the CV data, the photo, the attached CV's
 * link — and leaves everything HR has done alone: the stage, interviews,
 * notes, salary, onboarding, and any name, email or mobile somebody corrected.
 *
 * And every payload is kept (`candidate_bdjobs_payloads`), so the next fix
 * can rebuild CVs from it without asking BDJobs at all.
 *
 * Decorator-free so a test can import it.
 */

/** An inline image is kept in candidate_photos, not twice. */
const INLINE_IMAGE = /^data:image\//i;
const KEPT_ELSEWHERE = '[inline image — kept in candidate_photos]';

function withoutInlineImage(photo: unknown): unknown {
  if (!photo || typeof photo !== 'object' || Array.isArray(photo)) return photo;
  const p = photo as Record<string, unknown>;
  return typeof p.url === 'string' && INLINE_IMAGE.test(p.url.trim())
    ? { ...p, url: KEPT_ELSEWHERE }
    : p;
}

/**
 * The payload as kept: what BDJobs sent, less the signature timestamp (`ts`
 * means nothing once verified, and would make every resend look new) and
 * less any inline image bytes.
 */
export function storablePayload(dto: object): Record<string, unknown> {
  const { ts: _ts, ...rest } = dto as Record<string, unknown>;
  void _ts;
  const out: Record<string, unknown> = { ...rest };
  if ('photo' in out) out.photo = withoutInlineImage(out.photo);
  const profile = out.profile;
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    const p = profile as Record<string, unknown>;
    if ('photo' in p)
      out.profile = { ...p, photo: withoutInlineImage(p.photo) };
  }
  return out;
}

/** JSON with keys in a fixed order, so the same payload compares equal however it was spelled. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Is this resend the payload we already hold? A retry after a timeout is —
 * and must not cost an AI screen or touch the record.
 */
export function samePayload(stored: unknown, incoming: unknown): boolean {
  return (
    stored !== null &&
    stored !== undefined &&
    stable(stored) === stable(incoming)
  );
}

export interface ExistingCandidate {
  email: string | null;
  phone: string | null;
  gender: string | null;
  salaryExpectation: number | null;
  bdjobsApplicantId: string | null;
  cvFileId: string | null;
}

export interface Resent {
  cv: CvProfile | null;
  email: string | null;
  phone: string | null;
  gender: string | null;
  /** `resume.url` — the CV the applicant attached, when they did. */
  resumeUrl: string | null;
  applicantId: string | null;
}

/**
 * The fields a resend may change. BDJobs' own data is replaced; anything a
 * person can have typed in is only filled when it is still blank.
 */
export function refreshUpdate(
  existing: ExistingCandidate,
  resent: Resent,
  now: Date,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (resent.cv) {
    data.cvProfile = resent.cv;
    data.cvProfileAt = now;
  }
  // The attached CV's link — unless HR has since uploaded a file, which is
  // the CV the row opens and must stay so.
  if (resent.resumeUrl && !existing.cvFileId) data.cvUrl = resent.resumeUrl;
  if (!existing.email && resent.email) data.email = resent.email;
  if (!existing.phone && resent.phone) data.phone = resent.phone;
  if (!existing.gender && resent.gender) data.gender = resent.gender;
  if (existing.salaryExpectation == null && resent.cv?.compensation.expected)
    data.salaryExpectation = resent.cv.compensation.expected;
  if (!existing.bdjobsApplicantId && resent.applicantId)
    data.bdjobsApplicantId = resent.applicantId;
  return data;
}
