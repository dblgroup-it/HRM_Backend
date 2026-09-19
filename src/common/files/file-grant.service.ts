import { createHmac, timingSafeEqual } from 'node:crypto';

import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * What a grant is allowed to open. Purely descriptive — it is signed into the
 * payload so a grant minted for a CV cannot be replayed against a medical
 * report endpoint, and so an access log says what was opened.
 */
export type FilePurpose =
  | 'cv'
  | 'onboarding-doc'
  | 'medical-report'
  | 'requisition-attachment'
  | 'board-attachment'
  /** A marked answer script from a hand-marked screening test. */
  | 'exam-sheet'
  /**
   * A user's e-signature.
   *
   * Served through a grant rather than an open route like the avatar proxy.
   * An avatar leaking is a privacy nuisance; a signature is forgery material,
   * and user ids appear in ordinary API responses, so "you need to know the id"
   * is not a control. The grant is minted into a response the caller was
   * already entitled to receive, names one file, and expires.
   */
  | 'signature';

interface GrantPayload {
  /** Google Drive file id. Signed in, never taken from the request. */
  f: string;
  /** Purpose (see FilePurpose). */
  p: FilePurpose;
  /** Expiry, epoch seconds. */
  e: number;
  /** Suggested download filename, if the minting site knew one. */
  n?: string;
}

/** How long a freshly minted grant stays usable. */
const DEFAULT_TTL_SECONDS = 15 * 60;

/**
 * Short-lived, signed permission to stream one specific Drive file.
 *
 * ## Why this exists
 *
 * Sensitive documents used to be published to Drive with
 * `{ type: 'anyone', role: 'reader' }` — a permanent, unauthenticated,
 * unauditable URL for a medical report or a national ID. Files are now private
 * to the recruitment Google account and are only ever streamed by this API.
 *
 * ## Why a signed grant rather than a plain authenticated route
 *
 * The session JWT lives in `localStorage`, so it is *not* attached to a
 * top-level navigation — `<a href>` and `window.open` send no Authorization
 * header. A grant makes an ordinary link work while keeping the authorization
 * decision on the server, where it belongs.
 *
 * A grant is the **result** of an authorization check, never a substitute for
 * one: it is minted only inside a code path that has already established the
 * caller may see that record. Compared with what it replaces it is scoped to a
 * single file, expires in minutes rather than never, is served from our own
 * origin (so access can be logged and `Referrer-Policy` applies), and can be
 * invalidated wholesale by rotating `JWT_SECRET`.
 *
 * The file id is inside the signed payload, so a holder cannot edit the URL to
 * fetch a different document — tampering breaks the signature.
 */
@Injectable()
export class FileGrantService {
  private readonly key: Buffer;

  constructor(private readonly config: ConfigService) {
    // Derived from JWT_SECRET rather than a separate variable: it keeps
    // production configuration unchanged, and it means rotating the session
    // secret also invalidates every outstanding file grant, which is the
    // behaviour you want from a rotation.
    const secret = this.config.get<string>('jwt.secret') ?? '';
    this.key = createHmac('sha256', secret).update('file-grant-v1').digest();
  }

  /**
   * Mint a grant for one file. Call ONLY after the caller's right to see the
   * owning record has been established.
   */
  mint(
    fileId: string,
    purpose: FilePurpose,
    opts: { filename?: string; ttlSeconds?: number } = {},
  ): string {
    const payload: GrantPayload = {
      f: fileId,
      p: purpose,
      e:
        Math.floor(Date.now() / 1000) +
        (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
      ...(opts.filename ? { n: opts.filename.slice(0, 120) } : {}),
    };
    const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    return `${body}.${this.sign(body)}`;
  }

  /** The path a client should open. Relative, so it works behind any host. */
  url(
    fileId: string | null | undefined,
    purpose: FilePurpose,
    opts: { filename?: string; ttlSeconds?: number } = {},
  ): string | null {
    if (!fileId) return null;
    return `/api/files/${this.mint(fileId, purpose, opts)}`;
  }

  /** Verify and decode, or throw. Never reveals why beyond "no longer valid". */
  verify(grant: string): {
    fileId: string;
    purpose: FilePurpose;
    filename?: string;
  } {
    const dot = grant.lastIndexOf('.');
    if (dot <= 0) throw this.rejected();
    const body = grant.slice(0, dot);
    const signature = grant.slice(dot + 1);

    const expected = this.sign(body);
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw this.rejected();

    let payload: GrantPayload;
    try {
      payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as GrantPayload;
    } catch {
      throw this.rejected();
    }
    if (!payload?.f || !payload?.e) throw this.rejected();
    if (payload.e < Math.floor(Date.now() / 1000)) throw this.rejected();

    return { fileId: payload.f, purpose: payload.p, filename: payload.n };
  }

  private sign(body: string): string {
    return b64url(createHmac('sha256', this.key).update(body).digest());
  }

  private rejected(): ForbiddenException {
    return new ForbiddenException(
      'This document link is no longer valid. Reopen the record in DBL HRM to view the file.',
    );
  }
}

const b64url = (buf: Buffer): string => buf.toString('base64url');
