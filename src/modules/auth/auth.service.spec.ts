import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { AuthService, assertPasswordPolicy } from './auth.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../rbac/permissions.service';
import type { MailService } from '../integrations/mail/mail.service';
import type { JwtService } from '@nestjs/jwt';
import { SecretEncryptionService } from '../../common/crypto/secret-encryption.service';

/** Sign-in boundaries: which account an identifier resolves to, and whether a
 *  miss can be told apart from a hit. */
describe('AuthService.login', () => {
  const hash = bcrypt.hashSync('correct-horse', 4);

  function build(opts: {
    byCode?: unknown;
    byEmail?: unknown[];
    roleCount?: number;
  }) {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(opts.byCode ?? null),
        findMany: jest.fn().mockResolvedValue(opts.byEmail ?? []),
        update: jest.fn(),
      },
      employee: { findUnique: jest.fn().mockResolvedValue(null) },
      roleAssignment: {
        count: jest.fn().mockResolvedValue(opts.roleCount ?? 1),
      },
    } as unknown as PrismaService;
    const jwt = {
      sign: jest.fn().mockReturnValue('signed.jwt'),
    } as unknown as JwtService;
    const mail = { isConfigured: () => false } as unknown as MailService;
    const perms = {} as PermissionsService;
    // Real encryption service with a fixed test key — TOTP paths must exercise
    // actual AES, not a stub that would hide a broken envelope.
    const secrets = new SecretEncryptionService({
      get: (k: string) =>
        k === 'totpEncryptionKey' ? 'a'.repeat(64) : 'development',
    } as never);
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    // Signatures are serialized as signed grants; these tests never read one.
    const grants = {
      url: jest.fn(() => null),
    };
    return new AuthService(
      prisma,
      jwt,
      mail,
      perms,
      secrets,
      audit as never,
      grants as never,
    );
  }

  const user = (over: Record<string, unknown> = {}) => ({
    failedLoginAttempts: 0,
    lockedUntil: null,
    mustChangePassword: false,
    id: 'u1',
    employeeCode: '15100001',
    name: 'Test User',
    email: 'shared@dbl-group.com',
    phone: null,
    passwordHash: hash,
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    tokenVersion: 0,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    avatarFileId: null,
    ...over,
  });

  it('signs in by employee code', async () => {
    const svc = build({ byCode: user() });
    const res = await svc.login({
      identifier: '15100001',
      password: 'correct-horse',
    });
    expect(res).toHaveProperty('token', 'signed.jwt');
  });

  it('refuses an email shared by two accounts instead of picking one at random', async () => {
    // `users.email` has no unique constraint and the live data already holds
    // duplicates — the old findFirst returned whichever row Postgres reached.
    const svc = build({ byCode: null, byEmail: [user(), user({ id: 'u2' })] });
    await expect(
      svc.login({
        identifier: 'shared@dbl-group.com',
        password: 'correct-horse',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('gives the same answer for an unknown account and a wrong password', async () => {
    const missing = build({ byCode: null, byEmail: [] });
    const wrongPw = build({ byCode: user() });
    const a = await missing
      .login({ identifier: 'nobody@dbl-group.com', password: 'x-wrong-pass' })
      .catch((e: Error) => e.message);
    const b = await wrongPw
      .login({ identifier: '15100001', password: 'x-wrong-pass' })
      .catch((e: Error) => e.message);
    expect(a).toBe('Invalid credentials');
    expect(b).toBe('Invalid credentials');
  });

  it('still spends a password comparison when no account matched (no timing oracle)', async () => {
    // The dummy hash is cost-10 bcrypt, so a genuine comparison costs tens of
    // milliseconds. Returning early on "no such user" — the old behaviour —
    // came back in well under a millisecond, which is a reliable oracle for
    // whether an employee code exists. Anything above this floor can only be a
    // real comparison.
    const svc = build({ byCode: null, byEmail: [] });
    const started = process.hrtime.bigint();
    await svc
      .login({ identifier: 'nobody@dbl-group.com', password: 'x' })
      .catch(() => undefined);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThan(10);
  });

  it('refuses an inactive account', async () => {
    const svc = build({ byCode: user({ status: 'INACTIVE' }) });
    await expect(
      svc.login({ identifier: '15100001', password: 'correct-horse' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an account with no role assignment', async () => {
    const svc = build({ byCode: user(), roleCount: 0 });
    await expect(
      svc.login({ identifier: '15100001', password: 'correct-horse' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('will not let a user claim an email another account already uses', async () => {
    const svc = build({});
    (
      svc as unknown as { prisma: { user: { findFirst: jest.Mock } } }
    ).prisma.user.findFirst = jest.fn().mockResolvedValue({ id: 'other' });
    await expect(
      svc.ensureEmailFree('taken@dbl-group.com', 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('account lockout', () => {
    it('locks the account on the Nth consecutive wrong password', async () => {
      // One attempt short of the threshold; this failure crosses it.
      const svc = build({ byCode: user({ failedLoginAttempts: 4 }) });
      const prisma = (
        svc as unknown as { prisma: { user: { update: jest.Mock } } }
      ).prisma;
      await svc
        .login({ identifier: '15100001', password: 'wrong-password' })
        .catch(() => undefined);
      const written = prisma.user.update.mock.calls[0][0].data;
      expect(written.lockedUntil).toBeInstanceOf(Date);
      expect(written.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      expect(written.failedLoginAttempts).toBe(0);
    });

    it('counts up without locking below the threshold', async () => {
      const svc = build({ byCode: user({ failedLoginAttempts: 1 }) });
      const prisma = (
        svc as unknown as { prisma: { user: { update: jest.Mock } } }
      ).prisma;
      await svc
        .login({ identifier: '15100001', password: 'wrong-password' })
        .catch(() => undefined);
      expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
        failedLoginAttempts: 2,
      });
    });

    it('refuses a locked account even when the password is correct', async () => {
      const svc = build({
        byCode: user({ lockedUntil: new Date(Date.now() + 10 * 60_000) }),
      });
      await expect(
        svc.login({ identifier: '15100001', password: 'correct-horse' }),
      ).rejects.toThrow(/Too many failed sign-in attempts/);
    });

    it('lets a correct password through once the lock has expired', async () => {
      const svc = build({
        byCode: user({
          lockedUntil: new Date(Date.now() - 60_000),
          failedLoginAttempts: 4,
        }),
      });
      const res = await svc.login({
        identifier: '15100001',
        password: 'correct-horse',
      });
      expect(res).toHaveProperty('token');
    });

    it('clears the counter after a successful sign-in', async () => {
      const svc = build({ byCode: user({ failedLoginAttempts: 3 }) });
      const prisma = (
        svc as unknown as { prisma: { user: { update: jest.Mock } } }
      ).prisma;
      await svc.login({ identifier: '15100001', password: 'correct-horse' });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { failedLoginAttempts: 0, lockedUntil: null },
        }),
      );
    });
  });

  describe('first login', () => {
    it('tells the client the password must be changed', async () => {
      const svc = build({ byCode: user({ mustChangePassword: true }) });
      const res = await svc.login({
        identifier: '15100001',
        password: 'correct-horse',
      });
      expect(res).toMatchObject({ mustChangePassword: true });
    });
  });

  describe('password policy', () => {
    const target = {
      employeeCode: '15100001',
      email: 'someone@dbl-group.com',
      name: 'Test User',
    };

    it.each([
      ['too short', 'short123'],
      ['the employee code itself', '15100001'],
      ['contains the employee code', 'my15100001pass'],
      ['the email address', 'someone@dbl-group.com'],
      ['an obvious default', 'Password123'],
    ])('rejects %s', (_label, pw) => {
      expect(() => assertPasswordPolicy(pw, target)).toThrow();
    });

    it('accepts a passphrase, with no composition rules imposed', () => {
      expect(() =>
        assertPasswordPolicy('correct horse battery staple', target),
      ).not.toThrow();
    });

    it('rejects a password longer than bcrypt actually reads', () => {
      expect(() => assertPasswordPolicy('x'.repeat(73), target)).toThrow();
    });
  });
});
