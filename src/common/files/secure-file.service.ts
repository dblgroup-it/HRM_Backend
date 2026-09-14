import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';

import { DriveService } from '../../modules/integrations/google/drive.service';

/**
 * Streams a private Drive file back through this API.
 *
 * Deliberately streams rather than redirecting: a redirect to Drive would need
 * the file to be publicly readable again, which is the whole problem. Nothing
 * here decides *whether* the caller may have the file — that is settled before
 * a grant is minted (FileGrantService) or by the calling service's own
 * authorization check.
 */
@Injectable()
export class SecureFileService {
  private readonly logger = new Logger(SecureFileService.name);

  constructor(private readonly drive: DriveService) {}

  /**
   * Pipe the file to the client. `inline` so a PDF opens in the browser's
   * viewer the way the old Drive link did, rather than downloading.
   */
  async stream(
    res: Response,
    fileId: string,
    opts: { filename?: string; disposition?: 'inline' | 'attachment' } = {},
  ): Promise<void> {
    let media: {
      stream: NodeJS.ReadableStream;
      mimeType: string;
      name?: string;
    };
    try {
      media = await this.drive.getFileMedia(fileId);
    } catch (err) {
      // Drive's own status is preserved rather than collapsed into 404.
      // "Not found" and "we cannot reach Drive right now" are different
      // problems, and a blanket 404 sends whoever is debugging in the wrong
      // direction — which is exactly what happened with this regression.
      // Drive's error text is never forwarded to the caller.
      const status = driveErrorStatus(err);
      this.logger.warn(
        `Could not open Drive file ${fileId} (drive status ${status ?? 'unknown'}): ${(err as Error)?.message}`,
      );

      if (status === 404) {
        throw new NotFoundException('That document is no longer available.');
      }
      if (status === 403 || status === 401) {
        // The caller was already authorized — this is the *server's* Drive
        // credential being refused, so it is an outage, not the user's fault.
        throw new ServiceUnavailableException(
          'Document storage is temporarily unavailable. Please try again shortly.',
        );
      }
      if (status && status >= 500) {
        throw new ServiceUnavailableException(
          'Document storage is temporarily unavailable. Please try again shortly.',
        );
      }
      throw new ServiceUnavailableException(
        'That document could not be opened. Please try again shortly.',
      );
    }

    const name = sanitizeFilename(opts.filename ?? media.name ?? 'document');
    res.setHeader('Content-Type', media.mimeType);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(opts.disposition ?? 'inline', name),
    );
    // Confidential: never let a proxy or the browser keep a copy.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    media.stream.on('error', (err) => {
      this.logger.warn(`Stream failed for ${fileId}: ${err.message}`);
      if (!res.headersSent) res.status(404);
      res.end();
    });
    media.stream.pipe(res);
  }
}

/**
 * A filename safe to put inside a Content-Disposition header.
 *
 * Quotes, backslashes, semicolons and newlines would let a candidate-supplied
 * name break out of the quoted string and inject a second header directive.
 */
function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n]/g, ' ')
    .replace(/[";]/g, '')
    .replace(/[/\\]/g, '-')
    .trim();
  return cleaned.slice(0, 120) || 'document';
}

/**
 * Build a Content-Disposition header that Node will actually accept.
 *
 * Node's `setHeader` throws `ERR_INVALID_CHAR` on any character outside
 * Latin-1, and every CV in this system is named `"<Candidate> — CV.pdf"` with
 * an em dash (U+2014) — so the obvious one-liner threw on essentially every
 * real document, turning a working download into a 500.
 *
 * RFC 6266 is built for exactly this: `filename` carries a plain-ASCII
 * fallback for old clients, and `filename*` carries the real UTF-8 name,
 * percent-encoded so it is ASCII on the wire. Modern browsers prefer
 * `filename*`, so the reader still sees the em dash — it is only the
 * compatibility copy that is folded down.
 */
function contentDisposition(
  disposition: 'inline' | 'attachment',
  name: string,
): string {
  // Latin-1 punctuation that carries meaning, folded rather than dropped.
  const asciiFallback =
    name
      .replace(/[\u2010-\u2015]/g, '-') // hyphen/en/em dashes
      .replace(/[\u2018\u2019]/g, "'") // curly single quotes
      .replace(/[\u201C\u201D]/g, '') // curly double quotes (quotes are stripped)
      .replace(/\u2026/g, '...') // ellipsis
      // Anything still non-ASCII (Bengali names, accents) becomes "_" rather
      // than disappearing, so the fallback name stays recognisable in shape.
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\;]/g, '')
      .trim() || 'document';

  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * The HTTP status Google reported, if it reported one.
 *
 * googleapis surfaces it on `code` (a number) or nested under
 * `response.status`, depending on the failure. Anything unrecognisable returns
 * undefined so the caller falls back to a generic message rather than guessing.
 */
function driveErrorStatus(err: unknown): number | undefined {
  const e = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number };
  };
  const raw = e?.response?.status ?? e?.status ?? e?.code;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
