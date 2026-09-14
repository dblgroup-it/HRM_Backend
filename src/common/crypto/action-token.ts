import { createHash, randomBytes } from 'node:crypto';

/**
 * Tokens that stand in for a login on a public page — an evaluation link, an
 * onboarding page, a board vote, a facility confirmation, a proficiency test.
 *
 * ## Why they are hashed
 *
 * These were stored as the raw value. Anyone who could read the database — a
 * backup file, a replica, a support query, a leaked dump — could take a board
 * member's token and cast their vote, or open a candidate's onboarding page.
 * A raw token is a bearer credential, and bearer credentials get hashed for
 * the same reason passwords do.
 *
 * SHA-256 rather than bcrypt on purpose: unlike a password these are 128-256
 * bits of machine-generated randomness, so there is nothing to brute-force and
 * nothing a slow hash would buy — while a slow hash on every lookup would be
 * felt on pages that are opened from an email.
 *
 * ## The transition
 *
 * Rows written before this change hold a raw `token` and a null `tokenHash`.
 * `findByToken` looks for the hash first and falls back to the raw column, so
 * links already sitting in people's inboxes keep working. A legacy row is
 * upgraded the first time it is used. Once every legacy token has expired (see
 * the window in FINAL_GO_LIVE_GATE.md) the raw column can be dropped.
 */

/** 32 bytes = 256 bits. Unguessable by any practical means. */
export function generateActionToken(): string {
  return randomBytes(32).toString('hex');
}

/** The value stored in `tokenHash`. Deterministic, so lookup is a plain index hit. */
export function hashActionToken(raw: string): string {
  return createHash('sha256').update(raw.trim()).digest('hex');
}

/**
 * A `where` clause that finds a row by either the hashed or the legacy column.
 *
 * The raw value is matched only where no hash has been recorded, so a row that
 * has already been migrated cannot also be reached by its old raw value.
 */
export function tokenLookupWhere(raw: string): {
  OR: [
    { tokenHash: string },
    { AND: [{ token: string }, { tokenHash: null }] },
  ];
} {
  const trimmed = raw.trim();
  return {
    OR: [
      { tokenHash: hashActionToken(trimmed) },
      { AND: [{ token: trimmed }, { tokenHash: null }] },
    ],
  };
}

/**
 * Fields to write when issuing a new token.
 *
 * `token: null` is the point: the raw value is returned to the caller to put in
 * a link, and never written down.
 */
export function newTokenFields(raw: string): {
  token: null;
  tokenHash: string;
} {
  return { token: null, tokenHash: hashActionToken(raw) };
}

/** Fields that upgrade a legacy row in place, the first time it is used. */
export function migrateTokenFields(raw: string): {
  token: null;
  tokenHash: string;
} {
  return newTokenFields(raw);
}
