import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export interface AuthUser {
  id: string;
  employeeCode: string;
  name: string;
  role: UserRole;
  /** True while the account still holds a password somebody else chose for it. */
  mustChangePassword?: boolean;
  /**
   * This session's token id and expiry (seconds since epoch). Signing out
   * revokes just this one; absent on tokens issued before sessions had ids.
   */
  sessionId?: string;
  sessionExpiresAt?: number;
}

/** Injects the authenticated user (set by JwtStrategy) into a handler. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return request.user;
  },
);
