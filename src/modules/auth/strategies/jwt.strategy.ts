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
  /** Set on the short-lived token issued between password + 2FA steps. */
  pending2fa?: boolean;
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
    return {
      id: user.id,
      employeeCode: user.employeeCode,
      name: user.name,
      role: user.role,
    };
  }
}
