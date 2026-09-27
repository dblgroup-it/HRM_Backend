/**
 * The applicant's profile picture, as BDJobs sends it: a link, or the image
 * itself as a data: URI.
 *
 * Fetched once and stored, rather than linked to. The app's pages only load
 * images from their own origin or inline data, so a BDJobs-hosted URL would
 * never render — and a link that later expires would leave a hole in a CV
 * that has to stay readable.
 *
 * Decorator-free so the spec can drive it with a fake fetch.
 */

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

export type PhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface LoadedPhoto {
  mimeType: PhotoMime;
  data: Buffer;
  /** Null when it arrived inline. */
  sourceUrl: string | null;
}

/** Rejected with a reason that can be shown to the sender as-is. */
export class PhotoError extends Error {}

/**
 * What the bytes are, whatever the sender claimed. A Content-Type header or a
 * data: URI prefix is a label; the first bytes are the thing itself.
 */
export function detectImageMime(buf: Buffer): PhotoMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/**
 * May the server fetch this address?
 *
 * The link comes from outside. Without this check it could name the server's
 * own network — the database, the metadata service of a cloud host, a router's
 * admin page — and the server would fetch it on the sender's behalf. Checked
 * again at every redirect, since a public URL can bounce to a private one.
 */
export function isFetchableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;

  // IPv4 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a >= 224) return false; // multicast / reserved
    return true;
  }
  // IPv6 literal
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return false;
    if (/^f[cd]/.test(host)) return false; // unique local
    if (/^fe[89ab]/.test(host)) return false; // link local
    if (host.startsWith('::ffff:')) return isFetchableUrl(`http://${host.slice(7)}/`);
    return true;
  }
  // A bare hostname with no dot is a machine on the local network.
  return host.includes('.');
}

function checkBytes(data: Buffer): PhotoMime {
  if (!data.length) throw new PhotoError('The photo is empty.');
  if (data.length > PHOTO_MAX_BYTES)
    throw new PhotoError(
      `The photo is ${(data.length / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB.`,
    );
  const mime = detectImageMime(data);
  if (!mime)
    throw new PhotoError('The photo is not a JPEG, PNG or WebP image.');
  return mime;
}

/** A data: URI, decoded and checked. Null when `raw` is not one. */
export function decodeDataUri(raw: string): LoadedPhoto | null {
  const m = /^data:([a-z0-9.+/-]*)(;[a-z0-9=-]+)*;base64,/i.exec(raw.trim());
  if (!m) return null;
  const data = Buffer.from(raw.trim().slice(m[0].length), 'base64');
  return { mimeType: checkBytes(data), data, sourceUrl: null };
}

type FetchFn = typeof fetch;

/**
 * Load the photo from a data: URI or a link.
 *
 * Redirects are followed by hand so each hop is checked, the body is read with
 * a running size cap rather than trusting Content-Length, and the whole thing
 * gives up after eight seconds.
 */
export async function loadPhoto(
  raw: string,
  fetchFn: FetchFn = fetch,
): Promise<LoadedPhoto> {
  const inline = decodeDataUri(raw);
  if (inline) return inline;

  let url = raw.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      if (!isFetchableUrl(url))
        throw new PhotoError(
          hop === 0
            ? 'The photo link is not a public http(s) address.'
            : 'The photo link redirected to an address that is not public.',
        );
      const res = await fetchFn(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'image/jpeg,image/png,image/webp' },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        if (!next || hop >= MAX_REDIRECTS)
          throw new PhotoError('The photo link redirected too many times.');
        url = new URL(next, url).toString();
        continue;
      }
      if (!res.ok)
        throw new PhotoError(`The photo link answered HTTP ${res.status}.`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > PHOTO_MAX_BYTES)
        throw new PhotoError('The photo is larger than 2 MB.');

      const chunks: Buffer[] = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > PHOTO_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new PhotoError('The photo is larger than 2 MB.');
          }
          chunks.push(Buffer.from(value));
        }
      }
      const data = Buffer.concat(chunks);
      return { mimeType: checkBytes(data), data, sourceUrl: raw.trim().slice(0, 1000) };
    }
  } catch (e) {
    if (e instanceof PhotoError) throw e;
    if ((e as Error).name === 'AbortError')
      throw new PhotoError('The photo link did not answer within 8 seconds.');
    throw new PhotoError(`The photo could not be downloaded: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** For embedding in the generated CV. */
export function photoDataUri(p: { mimeType: string; data: Uint8Array }): string {
  return `data:${p.mimeType};base64,${Buffer.from(p.data).toString('base64')}`;
}
