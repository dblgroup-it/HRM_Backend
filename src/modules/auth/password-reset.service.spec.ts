import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

import {
  PasswordResetService,
  RESET_MAX_ATTEMPTS,
} from './password-reset.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../integrations/mail/mail.service';

/**
 * Forgot password: who may reset, that nothing tells a registered address
 * from an unknown one, that a code is single use with a guessing cap, and
 * that the reset token can never stand in for a session.
 */
describe('PasswordResetService', () => {
  const jwt = new JwtService({ secret: 'test-secret' });

  const user = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    employeeCode: '15100001',
    name: 'Test User',
    email: 'test.user@dbl-group.com',
    passwordHash: bcrypt.hashSync('old-pass1', 4),
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    tokenVersion: 3,
    resetOtpHash: null as string | null,
    resetOtpExpiresAt: null as Date | null,
    resetOtpAttempts: 0,
    resetOtpSentAt: null as Date | null,
    ...over,
  });

  function build(opts: { users?: unknown[]; roleCount?: number } = {}) {
    let rows = (opts.users ?? [user()]) as ReturnType<typeof user>[];
    const update = jest.fn(
      async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...rows[0] } as Record<string, unknown>;
        for (const [k, v] of Object.entries(data)) {
          row[k] =
            v && typeof v === 'object' && 'increment' in v
              ? (row[k] as number) + (v as { increment: number }).increment
              : v;
        }
        rows = [row as ReturnType<typeof user>];
        return row;
      },
    );
    const prisma = {
      user: {
        findMany: jest.fn(async () => rows),
        findUnique: jest.fn(async () => rows[0] ?? null),
        update,
      },
      roleAssignment: {
        count: jest.fn().mockResolvedValue(opts.roleCount ?? 1),
      },
    } as unknown as PrismaService;
    const mail = {
      send: jest.fn().mockResolvedValue({ messageId: 'x' }),
    } as unknown as MailService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = new PasswordResetService(prisma, jwt, mail, audit as never);
    return { svc, update, mail, row: () => rows[0] };
  }

  /** Let the fire-and-forget send run. */
  const flush = () => new Promise((r) => setImmediate(r));

  describe('request', () => {
    it('emails a code to an account that may sign in', async () => {
      const { svc, mail, row } = build();
      await expect(svc.request(' Test.User@dbl-group.com ')).resolves.toEqual({
        ok: true,
      });
      await flush();
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(row().resetOtpHash).toBeTruthy();
      expect(row().resetOtpAttempts).toBe(0);
    });

    it.each([
      ['an unknown address', { users: [] }],
      ['an employee with no role', { roleCount: 0 }],
      ['an inactive account', { users: [user({ status: 'INACTIVE' })] }],
      ['an address shared by two accounts', { users: [user(), user({ id: 'u2' })] }],
    ])('answers the same and sends nothing for %s', async (_label, opts) => {
      const { svc, mail, update } = build(opts);
      await expect(svc.request('test.user@dbl-group.com')).resolves.toEqual({
        ok: true,
      });
      await flush();
      expect(mail.send).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('lets the admin reset without any role assignment', async () => {
      const { svc, mail } = build({
        users: [user({ role: 'ADMIN' })],
        roleCount: 0,
      });
      await svc.request('test.user@dbl-group.com');
      await flush();
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('keeps the code already sent inside the cooldown', async () => {
      const { svc, mail } = build({
        users: [user({ resetOtpSentAt: new Date(Date.now() - 10_000) })],
      });
      await svc.request('test.user@dbl-group.com');
      await flush();
      expect(mail.send).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    const live = (code: string, over: Record<string, unknown> = {}) =>
      user({
        resetOtpHash: bcrypt.hashSync(code, 4),
        resetOtpExpiresAt: new Date(Date.now() + 60_000),
        ...over,
      });

    it('accepts the right code once, and returns a reset-only token', async () => {
      const { svc, row } = build({ users: [live('123456')] });
      const { resetToken } = await svc.verify(
        'test.user@dbl-group.com',
        ' 123456 ',
      );
      const payload = jwt.verify(resetToken);
      expect(payload).toMatchObject({ sub: 'u1', pwreset: true, tv: 3 });
      // Spent.
      expect(row().resetOtpHash).toBeNull();
      await expect(
        svc.verify('test.user@dbl-group.com', '123456'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('gives one message for wrong, expired and unknown', async () => {
      const wrong = build({ users: [live('123456')] });
      const expired = build({
        users: [live('123456', { resetOtpExpiresAt: new Date(Date.now() - 1) })],
      });
      const unknown = build({ users: [] });
      const messages = await Promise.all(
        [
          wrong.svc.verify('test.user@dbl-group.com', '000000'),
          expired.svc.verify('test.user@dbl-group.com', '123456'),
          unknown.svc.verify('nobody@dbl-group.com', '123456'),
        ].map((p) => p.catch((e: Error) => e.message)),
      );
      expect(new Set(messages).size).toBe(1);
    });

    it(`cancels the code after ${RESET_MAX_ATTEMPTS} wrong guesses`, async () => {
      const { svc, row } = build({ users: [live('123456')] });
      for (let i = 0; i < RESET_MAX_ATTEMPTS; i++) {
        await expect(
          svc.verify('test.user@dbl-group.com', '000000'),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(row().resetOtpHash).toBeNull();
      // Even the right code is refused now.
      await expect(
        svc.verify('test.user@dbl-group.com', '123456'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reset', () => {
    const tokenFor = (tv: number, extra: Record<string, unknown> = {}) =>
      jwt.sign({ sub: 'u1', tv, pwreset: true, ...extra }, { expiresIn: '5m' });

    it('sets the password and ends every session', async () => {
      const { svc, row } = build();
      await expect(svc.reset(tokenFor(3), 'newpass9')).resolves.toEqual({
        ok: true,
      });
      expect(bcrypt.compareSync('newpass9', row().passwordHash)).toBe(true);
      expect(row().tokenVersion).toBe(4);
    });

    it('cannot be used twice: the first reset voids the token', async () => {
      const { svc } = build();
      const token = tokenFor(3);
      await svc.reset(token, 'newpass9');
      await expect(svc.reset(token, 'another9')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses a session token', async () => {
      const { svc } = build();
      const session = jwt.sign({ sub: 'u1', tv: 3 });
      await expect(svc.reset(session, 'newpass9')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('holds the new password to the policy', async () => {
      const { svc } = build();
      await expect(svc.reset(tokenFor(3), '15100001')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.reset(tokenFor(3), 'old-pass1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses once the account has lost its access', async () => {
      const { svc } = build({ roleCount: 0 });
      await expect(svc.reset(tokenFor(3), 'newpass9')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  it('a reset token is never accepted as a session', async () => {
    const strategy = new JwtStrategy(
      { get: () => 'test-secret' } as never,
      { user: { findUnique: jest.fn() } } as never,
    );
    await expect(
      strategy.validate({
        sub: 'u1',
        employeeCode: '15100001',
        role: 'EMPLOYEE',
        tv: 3,
        pwreset: true,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
