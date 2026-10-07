import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proving an applicant owns the email address on a careers-page application.
 *
 * Applying is open to anyone, so the address was whatever was typed — a typo
 * sent the confirmation, the Application ID and every later letter to a
 * stranger, and nothing stopped an application being made in somebody else's
 * name. Now a six-digit code goes to the address and the application is only
 * accepted once it has come back.
 *
 *   1. `POST /apply/:reqId/email-code` mails a code (`ApplyEmailService`).
 *   2. `POST /apply/:reqId/email-code/verify` checks it and hands back a
 *      verification — a signed note saying "this address was proved at this
 *      time", good for VERIFIED_TTL_MS.
 *   3. `POST /apply/:reqId` refuses an application without one for its
 *      address.
 *
 * The verification names the address, not the job, so one proof covers
 * applying for several posts in the same sitting.
 *
 * Decorator-free so the spec can import it.
 */

/** How long an emailed code can be used. */
export const CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses a code can take before it is cancelled. */
export const MAX_ATTEMPTS = 5;
/** Minimum gap between two codes to one address. */
export const RESEND_COOLDOWN_MS = 60_000;
/** Codes one address can be sent in SEND_WINDOW_MS — a mailbox is not a target. */
export const MAX_SENDS_PER_WINDOW = 5;
export const SEND_WINDOW_MS = 60 * 60_000;
/** How long a proved address stays proved. */
export const VERIFIED_TTL_MS = 60 * 60_000;

/** One spelling per mailbox: "Rahim@Gmail.com " and "rahim@gmail.com" are one address. */
export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** What is stored about the last code sent to an address. */
export interface CodeState {
  codeHash: string | null;
  expiresAt: Date | null;
  attempts: number;
  sentAt: Date | null;
  windowStart: Date | null;
  windowCount: number;
}

export type SendDecision =
  /** Send a fresh code; `windowStart` / `windowCount` are what to store. */
  | { action: 'send'; windowStart: Date; windowCount: number }
  /** A code went less than a minute ago and still works: keep it. */
  | { action: 'wait'; resendInSeconds: number }
  /** Too many codes this hour. */
  | { action: 'limit'; retryInMinutes: number };

export function sendDecision(state: CodeState | null, now: Date): SendDecision {
  const t = now.getTime();
  if (
    state?.sentAt &&
    state.codeHash &&
    state.expiresAt &&
    state.expiresAt.getTime() > t &&
    t - state.sentAt.getTime() < RESEND_COOLDOWN_MS
  ) {
    return {
      action: 'wait',
      resendInSeconds: Math.ceil(
        (RESEND_COOLDOWN_MS - (t - state.sentAt.getTime())) / 1000,
      ),
    };
  }
  const inWindow =
    state?.windowStart != null &&
    t - state.windowStart.getTime() < SEND_WINDOW_MS;
  if (inWindow && state.windowCount >= MAX_SENDS_PER_WINDOW) {
    return {
      action: 'limit',
      retryInMinutes: Math.max(
        1,
        Math.ceil(
          (SEND_WINDOW_MS - (t - state.windowStart!.getTime())) / 60_000,
        ),
      ),
    };
  }
  return inWindow
    ? {
        action: 'send',
        windowStart: state.windowStart!,
        windowCount: state.windowCount + 1,
      }
    : { action: 'send', windowStart: now, windowCount: 1 };
}

/** Why a code cannot be checked at all, or null when it can. */
export function codeUnusable(
  state: CodeState | null,
  now: Date,
): 'none' | 'expired' | 'exhausted' | null {
  if (!state?.codeHash || !state.expiresAt) return 'none';
  if (state.attempts >= MAX_ATTEMPTS) return 'exhausted';
  if (state.expiresAt.getTime() <= now.getTime()) return 'expired';
  return null;
}

// --- the verification -------------------------------------------------------

/**
 * A key of its own, derived from the server secret, so a verification can
 * never be read as a session token or anything else signed with that secret.
 */
export const verificationKey = (serverSecret: string) =>
  createHmac('sha256', serverSecret)
    .update('apply-email-verification:v1')
    .digest();

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (key: Buffer, body: string) =>
  createHmac('sha256', key).update(body).digest('base64url');

export function signVerification(
  email: string,
  key: Buffer,
  now: Date,
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + VERIFIED_TTL_MS);
  const body = `v1.${b64(normaliseEmail(email))}.${expiresAt.getTime()}`;
  return { token: `${body}.${sign(key, body)}`, expiresAt };
}

/** The address a verification proves, or null if it is forged, mangled or spent. */
export function readVerification(
  token: string | null | undefined,
  key: Buffer,
  now: Date,
): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const body = parts.slice(0, 3).join('.');
  const given = Buffer.from(parts[3]);
  const expected = Buffer.from(sign(key, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  const expires = Number(parts[2]);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return null;
  return Buffer.from(parts[1], 'base64url').toString('utf8');
}
