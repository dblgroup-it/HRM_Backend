import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Authenticated encryption for secrets that must be read back, not just
 * compared — a TOTP seed above all.
 *
 * A password is hashed because nothing ever needs the original. A TOTP secret
 * is different: the server has to recompute codes from it on every sign-in, so
 * it cannot be hashed. Stored in the clear it is a second factor that anyone
 * with database access — a backup file, a replica, a support query — can
 * regenerate codes from indefinitely, which defeats the point of having it.
 *
 * AES-256-GCM: the auth tag means a tampered ciphertext fails to decrypt rather
 * than silently producing garbage that would be compared against a code.
 *
 * ## Stored format
 *
 *     v1.<iv>.<ciphertext>.<authTag>          (all base64url)
 *
 * The version prefix is what makes a future key rotation possible without a
 * flag day: a v2 reader can recognise and re-wrap v1 values on read.
 *
 * ## Legacy values
 *
 * Secrets written before this service existed are plain base32 with no prefix.
 * `decrypt()` returns those unchanged so nobody enrolled in an authenticator
 * app is locked out, and the calling code re-writes them encrypted on next
 * use. See `isEncrypted()`.
 */
@Injectable()
export class SecretEncryptionService {
  private readonly logger = new Logger(SecretEncryptionService.name);
  private readonly key: Buffer;

  constructor(private readonly config: ConfigService) {
    this.key = resolveKey(config, this.logger);
  }

  /** Is this stored value already in the encrypted envelope? */
  isEncrypted(value: string): boolean {
    return value.startsWith('v1.');
  }

  encrypt(plaintext: string): string {
    // A fresh IV per call: reusing one under GCM is catastrophic, and it also
    // means the same secret never produces the same ciphertext twice.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `v1.${b64(iv)}.${b64(ct)}.${b64(tag)}`;
  }

  /**
   * Decrypt, or pass a legacy plaintext value straight through.
   *
   * Throws only when a value *claims* to be encrypted and then fails to
   * authenticate — wrong key, or tampering. The error never carries the value.
   */
  decrypt(stored: string): string {
    if (!this.isEncrypted(stored)) return stored;

    const parts = stored.split('.');
    if (parts.length !== 4) throw this.failed();
    const [, ivPart, ctPart, tagPart] = parts;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivPart, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ctPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw this.failed();
    }
  }

  private failed(): InternalServerErrorException {
    // Deliberately vague to the caller and silent about the value itself.
    this.logger.error(
      'A stored secret could not be decrypted — TOTP_ENCRYPTION_KEY may have changed.',
    );
    return new InternalServerErrorException(
      'Two-factor authentication is temporarily unavailable. Please contact your administrator.',
    );
  }
}

const b64 = (b: Buffer): string => b.toString('base64url');

/**
 * The 32-byte key.
 *
 * Production must set TOTP_ENCRYPTION_KEY explicitly — `validateEnv()` in
 * main.ts refuses to boot without it. Outside production a key is derived from
 * JWT_SECRET so a developer checkout works with no extra setup; that derived
 * key is deliberately NOT usable in production, so a development database
 * restored into production cannot quietly decrypt with a guessable key.
 */
function resolveKey(config: ConfigService, logger: Logger): Buffer {
  const raw = config.get<string>('totpEncryptionKey') ?? '';
  if (raw) return normalizeKey(raw);

  if ((config.get<string>('nodeEnv') ?? 'development') === 'production') {
    // Unreachable in practice — validateEnv() exits first — but never fall
    // back to a derived key in production even if that guard is ever moved.
    throw new Error('TOTP_ENCRYPTION_KEY is required in production');
  }
  logger.warn(
    'TOTP_ENCRYPTION_KEY is not set — deriving a development key from JWT_SECRET. Set a real key before production.',
  );
  return createHash('sha256')
    .update(`${config.get<string>('jwt.secret') ?? ''}:totp-dev`)
    .digest();
}

/**
 * Accept the key as 64 hex characters, as base64/base64url, or as a passphrase.
 *
 * A raw 32-byte value is preferred (`openssl rand -hex 32`); anything else is
 * hashed to 32 bytes so a short or oddly-sized value can never silently
 * produce a weak key of the wrong length.
 */
export function normalizeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32) return decoded;
  return createHash('sha256').update(trimmed).digest();
}
