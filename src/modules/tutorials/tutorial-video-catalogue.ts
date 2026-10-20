import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The video tutorials recorded for the role guides — one mp4 per guide, cut
 * into the guide's chapters, with Bangla and English subtitles. They sit in
 * `assets/tutorial-videos/` beside `videos.json`; the mp4s are copied to the
 * server rather than committed, so an entry whose file is missing is simply
 * not offered.
 */
export interface TutorialVideoChapter {
  n: number;
  title: string;
  /** Where the chapter starts in the video. */
  startMs: number;
}

export interface TutorialVideoEntry {
  /** The guide it belongs to (`manifest.json` slug). */
  slug: string;
  file: string;
  title: string;
  durationMs: number;
  bytes: number;
  chapters: TutorialVideoChapter[];
  /** Language → WebVTT file name. */
  subtitles: Record<string, string>;
  poster?: string;
  /** ISO date the video was published to the app. */
  publishedAt?: string;
}

export interface TutorialVideoCatalogue {
  version: number;
  videos: TutorialVideoEntry[];
}

const SAFE_FILE = /^[A-Za-z0-9._-]+\.mp4$/;
const SAFE_VTT = /^[A-Za-z0-9._-]+\.vtt$/;
const SAFE_IMG = /^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/;

/** Read the catalogue; only entries whose video file is present. Null when there is none. */
export function readVideoCatalogue(dir: string): TutorialVideoCatalogue | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'videos.json'), 'utf8'));
  } catch {
    return null;
  }
  const c = raw as Partial<TutorialVideoCatalogue> | null;
  if (!c || !Array.isArray(c.videos)) return null;
  const videos = c.videos
    .filter(
      (v): v is TutorialVideoEntry =>
        Boolean(v) &&
        typeof v.slug === 'string' &&
        typeof v.file === 'string' &&
        SAFE_FILE.test(v.file) &&
        fs.existsSync(path.join(dir, v.file)),
    )
    .map((v) => ({
      slug: v.slug,
      file: v.file,
      title: typeof v.title === 'string' ? v.title : v.slug,
      durationMs: Number.isFinite(v.durationMs)
        ? Math.max(0, Math.round(v.durationMs))
        : 0,
      bytes: Number.isFinite(v.bytes) ? v.bytes : 0,
      chapters: (Array.isArray(v.chapters) ? v.chapters : [])
        .filter(
          (ch): ch is TutorialVideoChapter =>
            Boolean(ch) &&
            typeof ch.title === 'string' &&
            Number.isFinite(ch.startMs),
        )
        .map((ch, i) => ({
          n: Number.isInteger(ch.n) ? ch.n : i + 1,
          title: ch.title,
          startMs: Math.max(0, Math.round(ch.startMs)),
        }))
        .sort((a, b) => a.startMs - b.startMs)
        .slice(0, 30),
      subtitles: Object.fromEntries(
        Object.entries(v.subtitles ?? {}).filter(
          ([lang, file]) =>
            /^[a-z]{2}$/.test(lang) &&
            typeof file === 'string' &&
            SAFE_VTT.test(file) &&
            fs.existsSync(path.join(dir, file)),
        ),
      ) as Record<string, string>,
      poster:
        typeof v.poster === 'string' &&
        SAFE_IMG.test(v.poster) &&
        fs.existsSync(path.join(dir, v.poster))
          ? v.poster
          : undefined,
    }));
  return { version: Number(c.version ?? 1), videos };
}

/** Which bytes a `Range: bytes=…` header asks for, clamped to the file; null for none or nonsense. */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || size <= 0) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    // the last N bytes
    const n = Math.min(Number(b), size);
    start = size - n;
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    start >= size
  )
    return null;
  return { start, end };
}
