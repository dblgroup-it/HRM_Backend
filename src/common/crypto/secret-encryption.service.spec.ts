import {
  SecretEncryptionService,
  normalizeKey,
} from './secret-encryption.service';
import type { ConfigService } from '@nestjs/config';

const cfg = (key: string, env = 'production') =>
  ({
    get: (k: string) =>
      k === 'totpEncryptionKey' ? key : k === 'nodeEnv' ? env : 'jwt-secret',
  }) as unknown as ConfigService;

const KEY_A = 'a'.repeat(64); // 32 bytes of hex
const KEY_B = 'b'.repeat(64);

describe('SecretEncryptionService', () => {
  const svc = new SecretEncryptionService(cfg(KEY_A));
  const SECRET = 'JBSWY3DPEHPK3PXP';

  it('round-trips a secret', () => {
    expect(svc.decrypt(svc.encrypt(SECRET))).toBe(SECRET);
  });

  it('never stores the plaintext in the envelope', () => {
    const stored = svc.encrypt(SECRET);
    expect(stored).not.toContain(SECRET);
    expect(Buffer.from(stored).toString()).not.toContain(SECRET);
  });

  it('uses a fresh IV — the same secret encrypts differently every time', () => {
    const a = svc.encrypt(SECRET);
    const b = svc.encrypt(SECRET);
    expect(a).not.toBe(b);
    // ...but both still decrypt to the same value.
    expect(svc.decrypt(a)).toBe(svc.decrypt(b));
  });

  it('carries a version prefix so a future key rotation can be staged', () => {
    expect(svc.encrypt(SECRET).startsWith('v1.')).toBe(true);
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const stored = svc.encrypt(SECRET);
    const [v, iv, ct, tag] = stored.split('.');
    // Flip one character of the ciphertext.
    const flipped = ct[0] === 'A' ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    expect(() => svc.decrypt([v, iv, flipped, tag].join('.'))).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const [v, iv, ct, tag] = svc.encrypt(SECRET).split('.');
    const flipped = tag[0] === 'A' ? `B${tag.slice(1)}` : `A${tag.slice(1)}`;
    expect(() => svc.decrypt([v, iv, ct, flipped].join('.'))).toThrow();
  });

  it('cannot be decrypted with a different key', () => {
    const other = new SecretEncryptionService(cfg(KEY_B));
    expect(() => other.decrypt(svc.encrypt(SECRET))).toThrow();
  });

  it('passes a legacy plaintext secret through unchanged', () => {
    // Seeds written before encryption existed have no version prefix; an
    // enrolled authenticator must keep working across the upgrade.
    expect(svc.isEncrypted(SECRET)).toBe(false);
    expect(svc.decrypt(SECRET)).toBe(SECRET);
  });

  it('refuses to derive a key in production', () => {
    expect(() => new SecretEncryptionService(cfg('', 'production'))).toThrow();
  });

  it('normalises hex, base64 and passphrase keys to 32 bytes', () => {
    expect(normalizeKey(KEY_A)).toHaveLength(32);
    expect(normalizeKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(
      32,
    );
    expect(normalizeKey('a short passphrase')).toHaveLength(32);
  });
});
