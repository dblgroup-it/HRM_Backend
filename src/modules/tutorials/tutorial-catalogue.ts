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
   * Role keys whose holders see this guide. Super users and the platform
   * administrator see every guide, whatever is listed here.
   */
  roles: string[];
  /** The section it sits in on the page — "Requisition", "Onboarding"… */
  group: string;
  /** The cover as a small WebP, beside the PDF; absent on older builds. */
  thumb?: string;
  /** The guide's section titles, for "Inside this guide". */
  contents: string[];
  /** The same sections with the page each starts on, so a chapter opens at its page. */
  chapters: TutorialChapter[];
}

export interface TutorialChapter {
  title: string;
  /** 1-based; null when the build could not place it. */
  page: number | null;
}

export interface TutorialManifest {
  version: string;
  date: string;
  guides: TutorialEntry[];
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/;
const SAFE_THUMB = /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/;

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
    guides: guides
      .map((g) => ({
        ...g,
        group: typeof g.group === 'string' && g.group ? g.group : 'Guides',
        contents: Array.isArray(g.contents)
          ? g.contents
              .filter((c): c is string => typeof c === 'string')
              .slice(0, 20)
          : [],
        chapters: readChapters(g),
        // A missing or odd thumbnail costs the picture, not the guide.
        thumb:
          typeof g.thumb === 'string' &&
          SAFE_THUMB.test(g.thumb) &&
          fs.existsSync(path.join(dir, g.thumb))
            ? g.thumb
            : undefined,
      }))
      .sort((a, b) => a.number.localeCompare(b.number)),
  };
}

/**
 * A guide's chapters with their pages. A page outside the document is dropped
 * rather than trusted; a manifest from before chapters falls back to the
 * section titles, without pages.
 */
function readChapters(g: TutorialEntry): TutorialChapter[] {
  const pages = Number.isInteger(g.pages) ? g.pages : 0;
  const listed: unknown[] = Array.isArray(g.chapters)
    ? g.chapters
    : Array.isArray(g.contents)
      ? g.contents.map((title) => ({ title, page: null }))
      : [];
  return listed
    .filter(
      (c): c is { title: string; page?: unknown } =>
        Boolean(c) && typeof (c as { title?: unknown }).title === 'string',
    )
    .slice(0, 20)
    .map((c) => ({
      title: c.title,
      page:
        typeof c.page === 'number' &&
        Number.isInteger(c.page) &&
        c.page >= 1 &&
        c.page <= pages
          ? c.page
          : null,
    }));
}

/**
 * Whether this person sees a guide: only the guides for the roles they hold
 * — Factory HR sees the Factory HR guide, not the whole set. Super users and
 * the platform administrator, who support everybody, see every guide.
 */
export function canSee(
  guide: Pick<TutorialEntry, 'roles'>,
  roleKeys: readonly string[],
  seesEverything: boolean,
): boolean {
  return seesEverything || guide.roles.some((r) => roleKeys.includes(r));
}
