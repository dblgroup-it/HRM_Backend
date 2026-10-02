/**
 * What the API log keeps, and how it keeps it safe to read.
 *
 * Pure, so the rules are pinned by a spec: a log viewer is read by people
 * who must not be handed a working link into somebody's CV or marking sheet.
 */

/** Calls slower than this are kept even when they succeed. */
export const SLOW_MS = Number(process.env.API_LOG_SLOW_MS) || 3000;

/** Paths not worth a row: health probes and the log's own traffic. */
const SKIP = [
  /^\/api(\/v\d+)?\/health$/,
  /^\/api(\/v\d+)?\/api-logs/,
  /^\/api(\/v\d+)?\/client-errors$/,
];

/**
 * Should this finished request be logged? Every error, and every slow call.
 * 2xx/3xx answered in time are not — the audit log already records who
 * changed what.
 */
export function shouldLog(
  path: string,
  status: number,
  durationMs: number,
): 'error' | 'slow' | null {
  if (SKIP.some((re) => re.test(path))) return null;
  if (status >= 400) return 'error';
  if (durationMs >= SLOW_MS) return 'slow';
  return null;
}

/**
 * The path as it may be shown. Query strings are dropped (they carry
 * search terms and the odd token), and any segment long enough to be a
 * secret — emailed evaluation and board-vote tokens, signed file grants — is
 * masked. Record ids (cuids, 25 chars) stay readable.
 */
export function safePath(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  return path
    .split('/')
    .map((seg) => (seg.length > 30 ? ':token' : seg))
    .join('/')
    .slice(0, 500);
}

/** Error text cut to something a page can show. */
export function clip(
  text: string | null | undefined,
  max: number,
): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
