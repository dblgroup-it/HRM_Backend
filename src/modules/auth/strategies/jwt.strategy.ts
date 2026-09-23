import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuthUser } from '../../../common/decorators/current-user.decorator';

export interface JwtPayload {
  sub: string;
  employeeCode: string;
  role: UserRole;
  /** Token version at issue time — must match the user's current value. */
  tv?: number;
  /** Set on the short-lived token issued between password + 2FA steps. */
  pending2fa?: boolean;
  /** The account still holds a password it did not choose (see FirstLoginGuard). */
  mcp?: boolean;
  /** Wrong 2FA codes already spent against this challenge. */
  att?: number;
  /** This session's id — what signing out revokes. */
  jti?: string;
  /** Expiry, set by the signer. */
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret', 'dev-secret-change-me'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    // A pending-2FA token only authorizes the /auth/login/2fa step.
    if (payload.pending2fa) {
      throw new UnauthorizedException('Two-factor verification required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is inactive or not found');
    }
    // Reject tokens issued before a logout / password change (revocation).
    if ((payload.tv ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException('Session expired — please sign in again');
    }
    // This one session was signed out — the account's others are untouched.
    if (payload.jti) {
      const revoked = await this.prisma.revokedSession.findUnique({
        where: { jti: payload.jti },
        select: { jti: true },
      });
      if (revoked) {
        throw new UnauthorizedException('Signed out — please sign in again');
      }
    }
    return {
      id: user.id,
      employeeCode: user.employeeCode,
      name: user.name,
      role: user.role,
      // Read from the database, not from the token: a user cannot clear the
      // restriction by editing (or re-signing) their own JWT.
      mustChangePassword: user.mustChangePassword,
      sessionId: payload.jti,
      sessionExpiresAt: payload.exp,
    };
  }
}
