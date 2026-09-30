import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { User } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../integrations/mail/mail.service';
import { assertPasswordPolicy } from './auth.service';
import { JwtPayload } from './strategies/jwt.strategy';

/** How long an emailed reset code stays valid. */
export const RESET_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses one code can take before it is cancelled. */
export const RESET_MAX_ATTEMPTS = 5;
/** Minimum gap between two codes for one account. */
export const RESET_RESEND_COOLDOWN_MS = 60 * 1000;
/** Lifetime of the token that lets step 3 set the password. */
const RESET_TOKEN_TTL = '10m';

/** Said for every wrong, expired or unknown code, so none of them is an oracle. */
const BAD_CODE =
  'That code is incorrect or has expired. Check the latest email, or request a new code.';

/**
 * Forgot password, by a six-digit code emailed to the account's address.
 *
 *   1. `request(email)`  — mails a code, if the address belongs to exactly one
 *      account that may sign in. Always answers the same way.
 *   2. `verify(email, code)` — checks it; hands back a short-lived reset token.
 *   3. `reset(token, password)` — sets the password, ends every session.
 *
 * Only accounts that can already sign in may reset: active, and either the
 * admin or holding a role assignment — the same gate `AuthService.login`
 * applies. A synced employee with no access gets nothing, and learns nothing.
 *
 * Nothing here reveals whether an address is registered: step 1 answers
 * identically and sends the mail off the request path (a send takes seconds,
 * which would otherwise time the answer), and step 2 gives one message for
 * wrong, expired and unknown alike.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async request(rawEmail: string): Promise<{ ok: true }> {
    const user = await this.findEligible(rawEmail);
    if (!user) return { ok: true };

    // A second click inside the cooldown keeps the code already sent.
    if (
      user.resetOtpSentAt &&
      Date.now() - user.resetOtpSentAt.getTime() < RESET_RESEND_COOLDOWN_MS
    ) {
      return { ok: true };
    }

    // randomInt, not Math.random: this code is as good as the password.
    const code = String(randomInt(100000, 1000000));
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        resetOtpHash: await bcrypt.hash(code, 8),
        resetOtpExpiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
        resetOtpAttempts: 0,
        resetOtpSentAt: new Date(),
      },
    });
    await this.audit.record({
      action: 'password_reset_requested',
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name,
      summary: 'Requested a password reset code by email',
      actor: { id: null, name: user.name, type: 'public' },
      source: 'system',
    });

    // Off the request path, so the answer takes the same time either way.
    void this.sendCode(user.email!, user.name, code).catch((err: unknown) =>
      this.logger.error(
        `Password reset code for ${user.id} was not delivered: ${String(err)}`,
      ),
    );
    return { ok: true };
  }

  async verify(
    rawEmail: string,
    rawCode: string,
  ): Promise<{ resetToken: string }> {
    const code = rawCode.trim();
    const user = await this.findEligible(rawEmail);
    if (
      !user ||
      !user.resetOtpHash ||
      !user.resetOtpExpiresAt ||
      user.resetOtpExpiresAt < new Date() ||
      user.resetOtpAttempts >= RESET_MAX_ATTEMPTS
    ) {
      // Unknown address and dead code cost the same bcrypt round as a live one.
      await bcrypt.compare(code, user?.resetOtpHash ?? DUMMY_CODE_HASH);
      throw new BadRequestException(BAD_CODE);
    }

    const ok = await bcrypt.compare(code, user.resetOtpHash);
    if (!ok) {
      // Counted in the database, so a fresh browser tab is not a fresh budget.
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { resetOtpAttempts: { increment: 1 } },
      });
      if (updated.resetOtpAttempts >= RESET_MAX_ATTEMPTS) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { resetOtpHash: null, resetOtpExpiresAt: null },
        });
        await this.audit.record({
          action: 'password_reset_failed',
          entity: 'User',
          entityId: user.id,
          entityLabel: user.name,
          summary: `Password reset code cancelled after ${RESET_MAX_ATTEMPTS} incorrect attempts`,
          actor: { id: null, name: user.name, type: 'public' },
          source: 'system',
        });
      }
      throw new BadRequestException(BAD_CODE);
    }

    // Single use: the code is spent the moment it is accepted.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { resetOtpHash: null, resetOtpExpiresAt: null, resetOtpAttempts: 0 },
    });
    const payload: JwtPayload = {
      sub: user.id,
      employeeCode: user.employeeCode,
      role: user.role,
      // Pinned to the current version: the reset bumps it, so this token
      // cannot set a second password, and a sign-out-everywhere voids it.
      tv: user.tokenVersion,
      pwreset: true,
    };
    return {
      resetToken: this.jwt.sign(payload, { expiresIn: RESET_TOKEN_TTL }),
    };
  }

  async reset(resetToken: string, newPassword: string): Promise<{ ok: true }> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(resetToken);
    } catch {
      throw new UnauthorizedException(
        'This reset has timed out. Please request a new code.',
      );
    }
    if (!payload.pwreset) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (
      !user ||
      (payload.tv ?? 0) !== user.tokenVersion ||
      !(await this.canSignIn(user))
    ) {
      throw new UnauthorizedException(
        'This reset is no longer valid. Please request a new code.',
      );
    }

    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new BadRequestException(
        'New password must be different from the current one',
      );
    }
    assertPasswordPolicy(newPassword, user);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 12),
        // Ends every session, including one an attacker may hold: that is
        // usually why someone resets.
        tokenVersion: { increment: 1 },
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
        resetOtpHash: null,
        resetOtpExpiresAt: null,
        resetOtpAttempts: 0,
      },
    });
    await this.audit.record({
      action: 'password_reset_by_email',
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name,
      summary: 'Reset their password with an emailed code',
      actor: { id: user.id, name: user.name, type: 'user' },
      source: 'system',
    });
    if (user.email) {
      void this.sendChangedNotice(user.email, user.name).catch(() => undefined);
    }
    return { ok: true };
  }

  /**
   * The one account this address belongs to, if it may sign in. An address
   * shared by two accounts (the data holds some) resets neither: which one
   * was meant is a guess.
   */
  private async findEligible(rawEmail: string): Promise<User | null> {
    const email = rawEmail.trim();
    if (!email) return null;
    const matches = await this.prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      take: 2,
    });
    if (matches.length !== 1) return null;
    const user = matches[0];
    if (!user.email) return null;
    return (await this.canSignIn(user)) ? user : null;
  }

  /** The sign-in gate from AuthService.login: active, and admin or a role. */
  private async canSignIn(user: User): Promise<boolean> {
    if (user.status !== 'ACTIVE') return false;
    if (user.role === 'ADMIN') return true;
    const roles = await this.prisma.roleAssignment.count({
      where: { userId: user.id },
    });
    return roles > 0;
  }

  private async sendCode(to: string, name: string, code: string) {
    await this.mail.send({
      to,
      // Not in the subject: with email switched off, MailService logs the
      // subject, and a code in a log is a reset for whoever reads it.
      subject: 'Your DBL HRM password reset code',
      text: `Hello ${name},\n\nYour code to reset your DBL HRM password is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email; your password has not changed.`,
      html: `<div style="font-family:Arial,sans-serif;color:#0f172a">
        <p style="font-size:14px;color:#334155">Hello ${escapeHtml(name)},</p>
        <p style="font-size:14px;color:#334155">Your code to reset your DBL HRM password:</p>
        <p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#1877c0">${code}</p>
        <p style="font-size:12px;color:#94a3b8">It expires in 10 minutes. If you did not ask for this, ignore this email; your password has not changed.</p>
      </div>`,
    });
  }

  private async sendChangedNotice(to: string, name: string) {
    await this.mail.send({
      to,
      subject: 'Your DBL HRM password was changed',
      text: `Hello ${name},\n\nYour DBL HRM password was just reset using a code sent to this address, and every session was signed out.\n\nIf this was not you, contact your administrator straight away.`,
      html: `<div style="font-family:Arial,sans-serif;color:#0f172a">
        <p style="font-size:14px;color:#334155">Hello ${escapeHtml(name)},</p>
        <p style="font-size:14px;color:#334155">Your DBL HRM password was just reset using a code sent to this address, and every session was signed out.</p>
        <p style="font-size:13px;color:#b91c1c">If this was not you, contact your administrator straight away.</p>
      </div>`,
    });
  }
}

/** A bcrypt hash of a code nobody holds, for the equal-cost miss path. */
const DUMMY_CODE_HASH =
  '$2a$08$zhn0atqVd0ZPRw0XpNPt9ufuVMb8aZuq0.JseWqjb3sKj6yNYQMyq';

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
