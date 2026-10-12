/**
 * Email addresses typed into one box — "it@dbl-group.com, helpdesk@dbl-group.com".
 *
 * Commas, semicolons, spaces and line breaks all separate, because that is how
 * addresses arrive when pasted from Outlook or Gmail. Duplicates are dropped
 * case-insensitively, keeping the first spelling and the order. Anything that
 * is not an address comes back in `invalid`, so the caller can name it rather
 * than refuse the whole box.
 *
 * Decorator-free so specs can import it.
 */

/** Deliberately loose: one @, something on both sides, a dot in the domain. */
const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()".]{2,}$/;

export function isEmailAddress(value: string | null | undefined): boolean {
  return EMAIL.test((value ?? '').trim());
}

export function parseEmailList(raw: string | null | undefined): {
  valid: string[];
  invalid: string[];
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? '').split(/[\s,;]+/)) {
    const value = part.trim();
    if (!value) continue;
    if (!isEmailAddress(value)) {
      invalid.push(value);
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(value);
  }
  return { valid, invalid };
}
