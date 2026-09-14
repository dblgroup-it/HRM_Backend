import {
  generateActionToken,
  hashActionToken,
  newTokenFields,
  tokenLookupWhere,
} from './action-token';

/**
 * Public action tokens are bearer credentials. These prove the raw value never
 * reaches the database on a new token, and that links issued before hashing
 * still resolve during the transition.
 */
describe('action tokens', () => {
  it('generates 256 bits of entropy', () => {
    const t = generateActionToken();
    expect(t).toHaveLength(64); // 32 bytes as hex
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, generateActionToken));
    expect(seen.size).toBe(500);
  });

  it('stores only the hash — the raw value is never written', () => {
    const raw = generateActionToken();
    const fields = newTokenFields(raw);
    expect(fields.token).toBeNull();
    expect(fields.tokenHash).toBe(hashActionToken(raw));
    expect(fields.tokenHash).not.toBe(raw);
    expect(JSON.stringify(fields)).not.toContain(raw);
  });

  it('hashes deterministically, so lookup is a plain index hit', () => {
    const raw = generateActionToken();
    expect(hashActionToken(raw)).toBe(hashActionToken(raw));
    expect(hashActionToken(raw)).not.toBe(
      hashActionToken(generateActionToken()),
    );
  });

  it('ignores surrounding whitespace from a copy-pasted link', () => {
    const raw = generateActionToken();
    expect(hashActionToken(`  ${raw}\n`)).toBe(hashActionToken(raw));
  });

  it('looks up by hash, and by the raw column only where no hash exists', () => {
    const raw = generateActionToken();
    const where = tokenLookupWhere(raw);
    expect(where.OR[0]).toEqual({ tokenHash: hashActionToken(raw) });
    // The legacy branch is explicitly restricted to un-migrated rows, so a row
    // that has been upgraded can no longer be reached by its old raw value.
    expect(where.OR[1]).toEqual({
      AND: [{ token: raw }, { tokenHash: null }],
    });
  });
});
