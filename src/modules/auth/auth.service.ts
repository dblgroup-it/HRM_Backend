import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { User } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { MailService } from '../integrations/mail/mail.service';
import { buildAvatarUrl } from '../../common/avatar.util';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';

const ISSUER = 'DBL HRM';
const OTP_TTL_MS = 10 * 60 * 1000; // email codes valid 10 minutes
authenticator.options = { window: 1 }; // tolerate slight clock drift

export type LoginResult =
  | { token: string; user: UserResponse }
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
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly permissions: PermissionsService,
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
        // Locked out? Also clear 2FA + any pending code so they can get back in.
        twoFactorEnabled: false,
        twoFactorMethod: null,
        twoFactorSecret: null,
        otpHash: null,
        otpExpiresAt: null,
      },
    });
    return {
      ok: true,
      name: target.name,
      defaultPassword: target.employeeCode,
    };
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const identifier = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { employeeCode: identifier }] },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

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

    return { token: this.sign(user), user: await this.buildUser(user) };
  }

  // --- two-factor: login step --------------------------------------------

  private async issueChallenge(user: User): Promise<LoginResult> {
    const challengeToken = this.jwt.sign(
      { sub: user.id, pending2fa: true },
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
  ): Promise<{ token: string; user: UserResponse }> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(challengeToken);
    } catch {
      throw new UnauthorizedException(
        'Verification timed out — please sign in again.',
      );
    }
    if (!payload.pending2fa) throw new UnauthorizedException();
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.twoFactorEnabled) throw new UnauthorizedException();

    if (user.twoFactorMethod === 'totp') await this.verifyTotp(user, code);
    else await this.verifyEmailOtp(user, code);

    return { token: this.sign(user), user: await this.buildUser(user) };
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
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret },
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
    if (!authenticator.verify({ token: code, secret: user.twoFactorSecret })) {
      throw new BadRequestException('That code is incorrect — try again.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true, twoFactorMethod: 'totp' },
    });
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
    return { enabled: false };
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
    const code = String(Math.floor(100000 + Math.random() * 900000));
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

  private verifyTotp(user: User, code: string): void {
    if (
      !user.twoFactorSecret ||
      !authenticator.verify({
        token: code.trim(),
        secret: user.twoFactorSecret,
      })
    ) {
      throw new BadRequestException('That code is incorrect — try again.');
    }
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
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
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      // Bump token version so other sessions are signed out after a change.
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    return { ok: true };
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
    };
    return this.jwt.sign(payload);
  }

  /** Invalidate all of a user's existing tokens (logout / forced sign-out). */
  async logout(userId: string): Promise<{ ok: true }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
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
    };
  }

  async updateProfile(
    userId: string,
    dto: { name?: string; email?: string; phone?: string },
  ): Promise<UserResponse> {
    const data: { name?: string; email?: string; phone?: string } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;

    const user = await this.prisma.user.update({ where: { id: userId }, data });
    return this.buildUser(user);
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
