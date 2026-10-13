import { detectImageMime, isFetchableUrl } from './candidate-photo';

/**
 * Download a CV that lives at somebody else's address — the customized CV a
 * Bdjobs applicant attached, which reaches us as a link (`resume.url`), not a
 * file. The AI reads it beside their BDJobs profile, so the screen sees what
 * the candidate wrote as well as what they filled in.
 *
 * Same care as the photo fetch (candidate-photo.ts): the address is checked
 * before every hop, since a public link can redirect to the server's own
 * network; the body is read against a running cap rather than trusting
 * Content-Length; and it gives up after fifteen seconds. Only what the AI can
 * read is accepted — a PDF or an image. Nothing is stored.
 */

export const REMOTE_CV_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

export class RemoteCvError extends Error {}

export interface RemoteCv {
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
  data: Buffer;
}

/** What the bytes are, by their signature — never by the sender's say-so. */
export function detectCvMime(buf: Buffer): RemoteCv['mimeType'] | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-')
    return 'application/pdf';
  return detectImageMime(buf);
}

type FetchFn = typeof fetch;

export async function loadRemoteCv(
  raw: string,
  fetchFn: FetchFn = fetch,
): Promise<RemoteCv> {
  let url = raw.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      if (!isFetchableUrl(url))
        throw new RemoteCvError(
          hop === 0
            ? 'The CV link is not a public http(s) address.'
            : 'The CV link redirected to an address that is not public.',
        );
      const res = await fetchFn(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/pdf,image/*' },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        if (!next || hop >= MAX_REDIRECTS)
          throw new RemoteCvError('The CV link redirected too many times.');
        url = new URL(next, url).toString();
        continue;
      }
      if (!res.ok)
        throw new RemoteCvError(`The CV link answered HTTP ${res.status}.`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > REMOTE_CV_MAX_BYTES)
        throw new RemoteCvError('The CV is larger than 10 MB.');

      const chunks: Buffer[] = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > REMOTE_CV_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new RemoteCvError('The CV is larger than 10 MB.');
          }
          chunks.push(Buffer.from(value));
        }
      }
      const data = Buffer.concat(chunks);
      if (!data.length)
        throw new RemoteCvError('The CV link returned nothing.');
      const mimeType = detectCvMime(data);
      if (!mimeType)
        throw new RemoteCvError(
          'The CV is not a PDF or an image, so the AI cannot read it.',
        );
      return { mimeType, data };
    }
  } catch (e) {
    if (e instanceof RemoteCvError) throw e;
    if ((e as Error).name === 'AbortError')
      throw new RemoteCvError('The CV link did not answer within 15 seconds.');
    throw new RemoteCvError(
      `The CV could not be downloaded: ${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
