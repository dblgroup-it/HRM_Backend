import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { User } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretEncryptionService } from '../../common/crypto/secret-encryption.service';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../rbac/permissions.service';
import { MailService } from '../integrations/mail/mail.service';
import { buildAvatarUrl } from '../../common/avatar.util';
import { FileGrantService } from '../../common/files/file-grant.service';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';

const ISSUER = 'DBL HRM';
/** A real bcrypt hash of a value nobody knows — compared against when no
 *  account matched, so a miss costs the same as a hit. */
const DUMMY_HASH =
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const OTP_TTL_MS = 10 * 60 * 1000; // email codes valid 10 minutes
/** Consecutive wrong passwords before the account is locked. */
const MAX_FAILED_LOGINS = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5);
/** How long the lock lasts. Long enough to stop a guessing run, short enough
 *  that an honest user is not waiting on an administrator. */
const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15);
/** Wrong codes allowed against one 2FA challenge before it is torn down. */
const MAX_TWO_FACTOR_ATTEMPTS = 5;
authenticator.options = { window: 1 }; // tolerate slight clock drift

export type LoginResult =
  | { token: string; user: UserResponse; mustChangePassword: boolean }
  | {
      twoFactorRequired: true;
      method: string;
      challengeToken: string;
      email?: string;
    };

/** User shape returned to the client (frontend-friendly, lowercase role). */
export interface UserResponse {
  id: string;
  employeeCode: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  jobTitle: string | null;
  department: string | null;
  unit: string | null;
  avatarUrl: string | null;
  /** The user's e-signature, if they have one. */
  signatureUrl: string | null;
  /** True when they uploaded it themselves — HR may not then replace it. */
  signatureSelfUploaded: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly permissions: PermissionsService,
    private readonly secrets: SecretEncryptionService,
    private readonly audit: AuditService,
    private readonly grants: FileGrantService,
  ) {}

  /**
   * Super-user-only: reset a user's password back to the default (their
   * employee code) and clear any 2FA — for when someone is locked out.
   */
  async resetPasswordToDefault(targetUserId: string, actorId: string) {
    if (!(await this.permissions.isSuperUser(actorId))) {
      throw new ForbiddenException('Only a super user can reset passwords');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) throw new NotFoundException('User not found');

    const passwordHash = await bcrypt.hash(target.employeeCode, 10);
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        passwordHash,
        // Sign the account out everywhere. Without this, a session opened with
        // the old password keeps working after an admin resets it — which is
        // exactly the situation a reset is usually responding to.
        tokenVersion: { increment: 1 },
        // The new password is the employee code, which is not a secret: it is
        // printed in the directory every signed-in user can read. The account
        // can do nothing but change it.
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
        // Locked out? Also clear 2FA + any pending code so they can get back in.
        twoFactorEnabled: false,
        twoFactorMethod: null,
        twoFactorSecret: null,
        otpHash: null,
        otpExpiresAt: null,
      },
    });
    await this.audit.record({
      action: 'password_reset',
      entity: 'User',
      entityId: target.id,
      entityLabel: target.name,
      summary:
        'Password reset to the employee code by a super user; the account must change it at next sign-in',
      source: 'system',
    });
    return {
      ok: true,
      name: target.name,
      defaultPassword: target.employeeCode,
    };
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const identifier = dto.identifier.trim();
    const user = await this.resolveLoginUser(identifier);

    // Always spend a bcrypt comparison, even when no account matched. Skipping
    // it made a miss return in microseconds and a hit in ~100ms, which is a
    // reliable oracle for "does this employee code / email exist here".
    const valid = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_HASH,
    );

    // A locked account is refused before the password is even considered, so
    // the lock cannot be probed by trying the right password. The message is
    // the same one a wrong password gets, plus the time — telling a legitimate
    // user to come back in 15 minutes is worth more than hiding the fact that
    // the account exists, which a determined attacker already knows by now.
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.max(
        1,
        Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000),
      );
      throw new UnauthorizedException(
        `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    if (!user || user.status !== 'ACTIVE' || !valid) {
      if (user && user.status === 'ACTIVE' && !valid) {
        await this.recordFailedLogin(user);
        await this.audit.record({
          action: 'login_failed',
          entity: 'User',
          entityId: user.id,
          entityLabel: user.name,
          // The identifier that was tried is NOT recorded: it can be an email
          // address, and a failed attempt is not a reason to copy one into a
          // second table.
          summary: 'Failed sign-in attempt (incorrect password)',
          actor: { id: null, name: user.name, type: 'public' },
          source: 'system',
        });
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.clearFailedLogins(user);

    // Access gate: only the admin or users granted a role (in Access Control)
    // may sign in. Plain synced employees without a role assignment cannot.
    if (user.role !== 'ADMIN') {
      const roles = await this.prisma.roleAssignment.count({
        where: { userId: user.id },
      });
      if (roles === 0) {
        throw new UnauthorizedException(
          'Your account is not enabled for sign-in. Please ask your administrator to grant you access.',
        );
      }
    }

    // Second factor required → issue a short-lived challenge instead of a token.
    if (user.twoFactorEnabled && user.twoFactorMethod) {
      return this.issueChallenge(user);
    }

    await this.audit.record({
      action: 'login_success',
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name,
      summary: 'Signed in',
      actor: { id: user.id, name: user.name, type: 'user' },
      source: 'system',
    });
    return {
      token: this.sign(user),
      user: await this.buildUser(user),
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * Count a wrong password and lock the account once the threshold is crossed.
   *
   * Per-IP throttling alone does not protect an account: a distributed guesser
   * spends one attempt per address and never trips it. This counts against the
   * account itself, which is the thing being attacked.
   *
   * Never throws — a failure to record must not turn a wrong password into a
   * 500, which would itself distinguish real accounts from imaginary ones.
   */
  private async recordFailedLogin(user: User): Promise<void> {
    try {
      const attempts = user.failedLoginAttempts + 1;
      const lock = attempts >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: lock ? 0 : attempts,
          lockedUntil: lock
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : user.lockedUntil,
        },
      });
      if (lock) {
        await this.audit.record({
          action: 'account_locked',
          entity: 'User',
          entityId: user.id,
          entityLabel: user.name,
          summary: `Account locked for ${LOCKOUT_MINUTES} minutes after ${MAX_FAILED_LOGINS} failed sign-in attempts`,
          actor: { id: null, name: user.name, type: 'public' },
          source: 'system',
        });
      }
    } catch {
      // Best effort.
    }
  }

  /** A correct password clears the counter and any expired lock. */
  private async clearFailedLogins(user: User): Promise<void> {
    if (user.failedLoginAttempts === 0 && !user.lockedUntil) return;
    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    } catch {
      // Best effort.
    }
  }

  /**
   * Find the account an identifier refers to, unambiguously.
   *
   * `users.email` carries no unique constraint and the live data already holds
   * several addresses shared by two accounts, so the previous `findFirst` over
   * `OR: [email, employeeCode]` returned whichever row Postgres happened to
   * reach first. Employee code is the only identifier guaranteed unique, so it
   * is tried first; an email that matches more than one account is refused
   * rather than resolved by luck.
   */
  private async resolveLoginUser(identifier: string): Promise<User | null> {
    const byCode = await this.prisma.user.findUnique({
      where: { employeeCode: identifier },
    });
    if (byCode) return byCode;

    const byEmail = await this.prisma.user.findMany({
      where: { email: { equals: identifier, mode: 'insensitive' } },
      take: 2,
    });
    if (byEmail.length > 1) {
      throw new UnauthorizedException(
        'This email is registered to more than one account — sign in with your employee code instead.',
      );
    }
    return byEmail[0] ?? null;
  }

  // --- two-factor: login step --------------------------------------------

  private async issueChallenge(user: User): Promise<LoginResult> {
    const challengeToken = this.jwt.sign(
      { sub: user.id, pending2fa: true, att: 0 },
      { expiresIn: '5m' },
    );
    if (user.twoFactorMethod === 'email') {
      await this.sendEmailCode(user, 'sign in to DBL HRM');
    }
    return {
      twoFactorRequired: true,
      method: user.twoFactorMethod ?? 'email',
      challengeToken,
      email: maskEmail(user.email),
    };
  }

  async verifyLoginTwoFactor(
    challengeToken: string,
    code: string,
  ): Promise<{
    token: string;
    user: UserResponse;
    mustChangePassword: boolean;
  }> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(challengeToken);
    } catch {
      throw new UnauthorizedException(
        'Verification timed out — please sign in again.',
      );
    }
    if (!payload.pending2fa) throw new UnauthorizedException();

    // One challenge is not an unlimited guessing budget. The counter rides in
    // the challenge token itself (it is signed, so it cannot be edited) and a
    // fresh token is handed back after each wrong code; exhaust it and the
    // whole challenge is torn down, forcing the password step again.
    const attempts = payload.att ?? 0;
    if (attempts >= MAX_TWO_FACTOR_ATTEMPTS) {
      throw new UnauthorizedException(
        'Too many incorrect codes — please sign in again.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.twoFactorEnabled) throw new UnauthorizedException();

    try {
      if (user.twoFactorMethod === 'totp') await this.verifyTotp(user, code);
      else await this.verifyEmailOtp(user, code);
    } catch {
      const remaining = MAX_TWO_FACTOR_ATTEMPTS - attempts - 1;
      if (remaining <= 0) {
        await this.audit.record({
          action: 'two_factor_failed',
          entity: 'User',
          entityId: user.id,
          entityLabel: user.name,
          summary: `Two-factor challenge abandoned after ${MAX_TWO_FACTOR_ATTEMPTS} incorrect codes`,
          actor: { id: null, name: user.name, type: 'public' },
          source: 'system',
        });
        throw new UnauthorizedException(
          'Too many incorrect codes — please sign in again.',
        );
      }
      throw new BadRequestException({
        message: `That code is incorrect — ${remaining} attempt${remaining === 1 ? '' : 's'} left.`,
        // A replacement challenge carrying the incremented count.
        challengeToken: this.jwt.sign(
          { sub: user.id, pending2fa: true, att: attempts + 1 },
          { expiresIn: '5m' },
        ),
      });
    }

    await this.clearFailedLogins(user);
    await this.audit.record({
      action: 'login_success',
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name,
      summary: 'Signed in (two-factor verified)',
      actor: { id: user.id, name: user.name, type: 'user' },
      source: 'system',
    });
    return {
      token: this.sign(user),
      user: await this.buildUser(user),
      mustChangePassword: user.mustChangePassword,
    };
  }

  // --- two-factor: management (logged-in user) ---------------------------

  async twoFactorStatus(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return {
      enabled: Boolean(user?.twoFactorEnabled),
      method: user?.twoFactorEnabled ? (user?.twoFactorMethod ?? null) : null,
      hasEmail: Boolean(user?.email),
    };
  }

  /** Generate a TOTP secret + QR for the authenticator app (not yet enabled). */
  async setupTotp(userId: string) {
    const user = await this.requireUser(userId);
    const secret = authenticator.generateSecret();
    // Encrypted at rest: the seed can regenerate valid codes forever, so a
    // database copy must not be enough to defeat the second factor.
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: this.secrets.encrypt(secret) },
    });
    const label = user.email || user.employeeCode;
    const otpauthUrl = authenticator.keyuri(label, ISSUER, secret);
    const qr = await QRCode.toDataURL(otpauthUrl);
    return { secret, otpauthUrl, qr };
  }

  async enableTotp(userId: string, code: string) {
    const user = await this.requireUser(userId);
    if (!user.twoFactorSecret) {
      throw new BadRequestException('Start the authenticator setup first');
    }
    const secret = this.secrets.decrypt(user.twoFactorSecret);
    if (!authenticator.verify({ token: code, secret })) {
      throw new BadRequestException('That code is incorrect — try again.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: 'totp',
        // Upgrade a secret written before encryption existed, at the moment
        // the user proves they hold it — nobody is locked out by the change.
        ...(this.secrets.isEncrypted(user.twoFactorSecret)
          ? {}
          : { twoFactorSecret: this.secrets.encrypt(secret) }),
      },
    });
    await this.auditTwoFactor(user, 'two_factor_enabled', 'authenticator app');
    return { enabled: true, method: 'totp' };
  }

  /** Email a code to confirm the user controls the inbox before enabling. */
  async startEmailSetup(userId: string) {
    const user = await this.requireUser(userId);
    if (!user.email) {
      throw new BadRequestException(
        'Add an email to your profile before enabling email 2FA',
      );
    }
    await this.sendEmailCode(user, 'enable two-factor authentication');
    return { sent: true, email: maskEmail(user.email) };
  }

  async enableEmail(userId: string, code: string) {
    const user = await this.requireUser(userId);
    await this.verifyEmailOtp(user, code);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: 'email',
        twoFactorSecret: null,
      },
    });
    await this.auditTwoFactor(user, 'two_factor_enabled', 'email code');
    return { enabled: true, method: 'email' };
  }

  async disableTwoFactor(userId: string, password: string) {
    const user = await this.requireUser(userId);
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new BadRequestException('Password is incorrect');
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorMethod: null,
        twoFactorSecret: null,
        otpHash: null,
        otpExpiresAt: null,
      },
    });
    await this.auditTwoFactor(user, 'two_factor_disabled', 'disabled');
    return { enabled: false };
  }

  /** One shape for every 2FA change. Never records the method's secret. */
  private async auditTwoFactor(
    user: User,
    action: 'two_factor_enabled' | 'two_factor_disabled',
    detail: string,
  ): Promise<void> {
    await this.audit.record({
      action,
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name,
      summary:
        action === 'two_factor_enabled'
          ? `Enabled two-factor authentication (${detail})`
          : 'Disabled two-factor authentication',
      actor: { id: user.id, name: user.name, type: 'user' },
      source: 'system',
    });
  }

  // --- two-factor: helpers ------------------------------------------------

  private async requireUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  private async sendEmailCode(user: User, purpose: string): Promise<void> {
    if (!user.email) throw new BadRequestException('No email on file');
    if (!this.mail.isConfigured()) {
      throw new ServiceUnavailableException('Email is not configured');
    }
    // randomInt, not Math.random: V8's PRNG is predictable from a handful of
    // observed outputs, and this code is a second authentication factor.
    const code = String(randomInt(100000, 1000000));
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpHash: await bcrypt.hash(code, 8),
        otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });
    await this.mail.send({
      to: user.email,
      subject: `${code} is your DBL HRM verification code`,
      text: `Your verification code to ${purpose} is ${code}. It expires in 10 minutes.`,
      html: `<div style="font-family:Arial,sans-serif;color:#0f172a">
        <p style="font-size:14px;color:#334155">Your verification code to ${purpose}:</p>
        <p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#1877c0">${code}</p>
        <p style="font-size:12px;color:#94a3b8">Expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>`,
    });
  }

  private async verifyEmailOtp(user: User, code: string): Promise<void> {
    if (!user.otpHash || !user.otpExpiresAt || user.otpExpiresAt < new Date()) {
      throw new BadRequestException('Code expired — request a new one.');
    }
    const ok = await bcrypt.compare(code.trim(), user.otpHash);
    if (!ok)
      throw new BadRequestException('That code is incorrect — try again.');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { otpHash: null, otpExpiresAt: null },
    });
  }

  /**
   * Verify a TOTP code.
   *
   * Reads through `SecretEncryptionService`, which returns a legacy plaintext
   * seed unchanged — so an authenticator enrolled before encryption was added
   * keeps working, and `migrateTotpSecret` re-writes it encrypted afterwards.
   */
  private async verifyTotp(user: User, code: string): Promise<void> {
    if (!user.twoFactorSecret) {
      throw new BadRequestException('That code is incorrect — try again.');
    }
    const secret = this.secrets.decrypt(user.twoFactorSecret);
    if (!authenticator.verify({ token: code.trim(), secret })) {
      throw new BadRequestException('That code is incorrect — try again.');
    }
    await this.migrateTotpSecret(user, secret);
  }

  /** Lazily re-wrap a plaintext seed once its owner has proved they hold it. */
  private async migrateTotpSecret(user: User, secret: string): Promise<void> {
    if (
      !user.twoFactorSecret ||
      this.secrets.isEncrypted(user.twoFactorSecret)
    ) {
      return;
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: this.secrets.encrypt(secret) },
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true; token: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      throw new BadRequestException('Current password is incorrect');
    }
    const same = await bcrypt.compare(newPassword, user.passwordHash);
    if (same) {
      throw new BadRequestException(
        'New password must be different from the current one',
      );
    }
    assertPasswordPolicy(newPassword, user);

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      // Bump token version so other sessions are signed out after a change,
      // and clear the first-login restriction this may have been fixing.
      data: {
        passwordHash,
        tokenVersion: { increment: 1 },
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await this.audit.record({
      action: 'password_changed',
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name,
      summary: 'Changed their own password',
      actor: { id: user.id, name: user.name, type: 'user' },
      source: 'system',
    });
    // The caller's own token was just invalidated along with every other
    // session, so hand back a fresh one — otherwise changing your password
    // signs you out, which is a poor experience on a forced first change.
    const refreshed = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return { ok: true, token: this.sign(refreshed) };
  }

  async me(userId: string): Promise<UserResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.buildUser(user);
  }

  private sign(user: User): string {
    const payload: JwtPayload = {
      sub: user.id,
      employeeCode: user.employeeCode,
      role: user.role,
      tv: user.tokenVersion,
      // Marks a session that has authenticated but still holds a password
      // somebody else chose. FirstLoginGuard lets it reach only the endpoints
      // needed to fix that; the flag is re-read from the database on every
      // request, so it cannot be stripped from the token to gain access.
      ...(user.mustChangePassword ? { mcp: true } : {}),
    };
    return this.jwt.sign(payload);
  }

  /** Invalidate all of a user's existing tokens (logout / forced sign-out). */
  async logout(userId: string): Promise<{ ok: true }> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    await this.audit.record({
      action: 'logout',
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name,
      summary: 'Signed out (all sessions invalidated)',
      actor: { id: user.id, name: user.name, type: 'user' },
      source: 'system',
    });
    return { ok: true };
  }

  async buildUser(user: User): Promise<UserResponse> {
    const profile = await this.prisma.employee.findUnique({
      where: { userId: user.id },
    });
    return {
      id: user.id,
      employeeCode: user.employeeCode,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role.toLowerCase(),
      jobTitle: profile?.designation ?? null,
      department: profile?.department ?? null,
      unit: profile?.unitName ?? null,
      avatarUrl: buildAvatarUrl(user.id, user.avatarFileId),
      // A signed, expiring grant rather than an open route — see FilePurpose.
      signatureUrl: this.grants.url(user.signatureFileId, 'signature', {
        filename: `${user.name} signature`,
      }),
      signatureSelfUploaded: user.signatureUploadedById === user.id,
    };
  }

  async updateProfile(
    userId: string,
    dto: { name?: string; email?: string; phone?: string },
  ): Promise<UserResponse> {
    const data: { name?: string; email?: string; phone?: string } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) {
      // An address is how one of the two sign-in identifiers is matched and
      // where the email second factor is delivered, so it cannot be pointed at
      // an address another account already uses.
      await this.ensureEmailFree(dto.email, userId);
      data.email = dto.email;
    }
    if (dto.phone !== undefined) data.phone = dto.phone;

    const user = await this.prisma.user.update({ where: { id: userId }, data });
    return this.buildUser(user);
  }

  /**
   * Refuse an email already registered to a different account.
   *
   * There is no unique constraint on `users.email` (the live data holds
   * duplicates that predate this check, so one cannot simply be added), which
   * makes this the only thing standing between a user and claiming a
   * colleague's sign-in identifier.
   */
  async ensureEmailFree(email: string, selfUserId: string): Promise<void> {
    const trimmed = email.trim();
    if (!trimmed) return;
    const clash = await this.prisma.user.findFirst({
      where: {
        email: { equals: trimmed, mode: 'insensitive' },
        NOT: { id: selfUserId },
      },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException(
        'That email address is already registered to another account.',
      );
    }
  }
}

/** Mask an email for display: john.doe@dbl-group.com → jo•••@dbl-group.com */
function maskEmail(email: string | null): string {
  if (!email) return '';
  const [name, domain] = email.split('@');
  if (!domain) return email;
  const head = name.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

/** Minimum length. Long enough to matter, short enough that a passphrase fits
 *  comfortably and nobody reaches for "Passw0rd!". */
const MIN_PASSWORD_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH ?? 12);

/**
 * Reject a new password that is not actually a secret.
 *
 * Deliberately no composition rules (one upper, one digit, one symbol): they
 * push people towards short predictable patterns and towards writing the
 * result down. Length plus a handful of specific exclusions catches what
 * actually goes wrong here — the employee code, which every signed-in user can
 * read out of the directory, and which is this system's provisioning default.
 */
export function assertPasswordPolicy(
  password: string,
  user: { employeeCode: string; email: string | null; name: string },
): void {
  const pw = password.trim();

  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestException(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters. A short sentence you will remember works well.`,
    );
  }
  // bcrypt silently ignores everything past 72 bytes, so a longer password
  // would give a false sense of strength.
  if (Buffer.byteLength(pw, 'utf8') > 72) {
    throw new BadRequestException('Password must be 72 bytes or fewer.');
  }
  const lower = pw.toLowerCase();
  if (lower === user.employeeCode.toLowerCase()) {
    throw new BadRequestException(
      'Your password cannot be your employee code — it is visible to every colleague in the directory.',
    );
  }
  if (user.email && lower === user.email.toLowerCase()) {
    throw new BadRequestException(
      'Your password cannot be your email address.',
    );
  }
  if (lower.includes(user.employeeCode.toLowerCase())) {
    throw new BadRequestException(
      'Your password cannot contain your employee code.',
    );
  }
  const OBVIOUS = new Set([
    'password123',
    'password1234',
    'dblgroup1234',
    'dbl@12345678',
    '123456789012',
    'qwertyuiop12',
    'administrator',
    'welcome12345',
  ]);
  if (OBVIOUS.has(lower.replace(/\s+/g, ''))) {
    throw new BadRequestException(
      'That password is too easy to guess. Please choose another.',
    );
  }
}
