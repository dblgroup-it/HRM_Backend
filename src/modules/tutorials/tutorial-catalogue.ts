/**
 * The Tutorials menu: DBL HRM's client documentation — the System Workflow
 * master document and one guide per role — as PDFs shipped with the API in
 * `assets/tutorials/`, described by `manifest.json` beside them.
 *
 * Both are produced by the documentation build
 * (`docs/source/client-guides/build.mjs`), so the list and the files cannot
 * disagree. Decorator-free so specs can import it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TutorialEntry {
  /** Stable id: `master`, `raiser`, `recruiter`… */
  slug: string;
  /** "00" … "12", the order the guides are printed in. */
  number: string;
  /** File name inside the tutorials folder — never a path. */
  file: string;
  title: string;
  /** "Role Guide 07", "System Workflow · Master Document". */
  kicker: string;
  subtitle: string;
  /** Who the guide is written for, in a sentence. */
  audience: string;
  pages: number;
  bytes: number;
  /**
   * Role keys the guide is for — "For you" on the page. `*` is everybody;
   * `admin` is the platform administrator login.
   */
  roles: string[];
}

export interface TutorialManifest {
  version: string;
  date: string;
  guides: TutorialEntry[];
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/;

/**
 * The manifest, keeping only well-formed entries whose PDF is really there.
 * Null when there is no manifest at all, so the page can say so plainly.
 */
export function readManifest(dir: string): TutorialManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  const m = raw as Partial<TutorialManifest> | null;
  if (!m || !Array.isArray(m.guides)) return null;
  const guides = m.guides.filter(
    (g): g is TutorialEntry =>
      Boolean(g) &&
      typeof g.slug === 'string' &&
      typeof g.file === 'string' &&
      SAFE_FILE.test(g.file) &&
      typeof g.title === 'string' &&
      Array.isArray(g.roles) &&
      fs.existsSync(path.join(dir, g.file)),
  );
  return {
    version: String(m.version ?? ''),
    date: String(m.date ?? ''),
    guides: [...guides].sort((a, b) => a.number.localeCompare(b.number)),
  };
}

/** Whether a guide is written for this person — by their roles, or the admin login. */
export function isForYou(
  guide: Pick<TutorialEntry, 'roles'>,
  roleKeys: readonly string[],
  isAdminLogin: boolean,
): boolean {
  return guide.roles.some(
    (r) => r === '*' || (r === 'admin' && isAdminLogin) || roleKeys.includes(r),
  );
}
