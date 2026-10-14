import type { FileGrantService } from '../../../common/files/file-grant.service';

/**
 * The link to a candidate's BDJobs CV — their application rendered as a PDF.
 *
 * **One CV per candidate, the personal one first** (owner's decision,
 * 2026-10-14 — two buttons side by side was noise). A candidate who has a
 * CV of their own (the file they attached on BDJobs, an upload, a Drive
 * file: `cvUrl` / `cvFileId`) is shown that, and no BDJobs CV link is made.
 * Only when there is no personal CV is the stored profile offered as the
 * CV — for a Bdjobs applicant who attached nothing, the "BDJobs CV". The AI
 * still reads both for its summary; this is only about what opens.
 *
 * The one exception is the recruiter's own candidate row in the pipeline,
 * which shows both (`alongsidePersonal`) — the owner's call on the same day.
 * The serialized candidate carries both for it; every other screen's
 * `CvLink` still opens one, personal first.
 *
 * A signed grant on `GET /candidates/profile-cv/:grant`, minted only where
 * the caller already passed that screen's own check (a login with access, an
 * evaluation token, a board token). It lasts as long as that access does:
 * minutes in the app, the token's life on a token page, a month in an
 * emailed sheet — the same rule the CV file's own grant follows.
 */

export interface ProfileCvCandidate {
  id: string;
  name: string;
  cvProfile?: unknown;
  cvFileId?: string | null;
  cvUrl?: string | null;
}

export interface ProfileCvLink {
  /** Relative (`/api/...`) — absolutise it for an email. Null whenever there is a personal CV. */
  profileCvUrl: string | null;
  /**
   * Where the stored profile came from — 'bdjobs' for a BDJobs applicant —
   * sent even when no link is, so the one CV button can say which CV it is:
   * "Personal CV" or "BDJobs CV".
   */
  profileCvSource: string | null;
}

const MIN_TTL = 15 * 60;
const MAX_TTL = 30 * 24 * 60 * 60;

/** Seconds from now until `until`, kept between 15 minutes and 30 days. */
export function ttlUntil(
  until: Date | null | undefined,
  now = Date.now(),
): number {
  if (!until) return MIN_TTL;
  const s = Math.floor((until.getTime() - now) / 1000);
  return Math.min(MAX_TTL, Math.max(MIN_TTL, s));
}

export function profileCvLink(
  files: Pick<FileGrantService, 'mint'>,
  c: ProfileCvCandidate,
  opts: {
    ttlSeconds?: number;
    /** The pipeline row: a BDJobs applicant's BDJobs CV even beside their own. */
    alongsidePersonal?: boolean;
  } = {},
): ProfileCvLink {
  const source = (c.cvProfile as { source?: unknown } | null | undefined)
    ?.source;
  const profileCvSource =
    c.cvProfile && typeof source === 'string' ? source : null;
  // The personal CV wins: with one, there is no second link to make —
  // except beside it on the pipeline row, and then only for a BDJobs
  // application (an upload's profile is the AI's reading of that same file).
  const hasPersonal = Boolean(c.cvFileId || c.cvUrl);
  const offer =
    Boolean(c.cvProfile) &&
    (!hasPersonal || (opts.alongsidePersonal === true && source === 'bdjobs'));
  if (!offer) return { profileCvUrl: null, profileCvSource };
  return {
    profileCvUrl: `/api/candidates/profile-cv/${files.mint(c.id, 'cv-profile', {
      filename: `${c.name} — CV`,
      ttlSeconds: opts.ttlSeconds,
    })}`,
    profileCvSource,
  };
}
