import type { FileGrantService } from '../../../common/files/file-grant.service';

/**
 * The link to a candidate's BDJobs CV — their application rendered as a PDF —
 * for every screen that offers a CV, so each shows what the recruiter's row
 * shows: "Personal CV" (the file they attached, `cvUrl`) and "BDJobs CV".
 *
 * A signed grant on `GET /candidates/profile-cv/:grant`, minted only where
 * the caller already passed that screen's own check (a login with access, an
 * evaluation token, a board token). It lasts as long as that access does:
 * minutes in the app, the token's life on a token page, a month in an
 * emailed sheet — the same rule the CV file's own grant follows.
 *
 * Offered for a Bdjobs application, and for any candidate whose stored
 * profile is the only CV there is; never for an uploaded file, whose profile
 * is just the AI's reading of that same document.
 */

export interface ProfileCvCandidate {
  id: string;
  name: string;
  cvProfile?: unknown;
  cvFileId?: string | null;
  cvUrl?: string | null;
}

export interface ProfileCvLink {
  /** Relative (`/api/...`) — absolutise it for an email. */
  profileCvUrl: string | null;
  /** 'bdjobs' labels it "BDJobs CV" (and the file "Personal CV"). */
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
  opts: { ttlSeconds?: number } = {},
): ProfileCvLink {
  const source = (c.cvProfile as { source?: unknown } | null | undefined)
    ?.source;
  const show =
    Boolean(c.cvProfile) && (source === 'bdjobs' || (!c.cvFileId && !c.cvUrl));
  if (!show) return { profileCvUrl: null, profileCvSource: null };
  return {
    profileCvUrl: `/api/candidates/profile-cv/${files.mint(c.id, 'cv-profile', {
      filename: `${c.name} — CV`,
      ttlSeconds: opts.ttlSeconds,
    })}`,
    profileCvSource: typeof source === 'string' ? source : null,
  };
}
