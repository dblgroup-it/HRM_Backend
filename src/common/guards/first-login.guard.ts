import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * Endpoints a session may still reach while it holds a password it did not
 * choose. Matched against the path with the global `api` prefix stripped.
 *
 * Deliberately tiny: change the password, see who you are, sign out. Anything
 * that would read employee, candidate, salary or medical data is out, because
 * the whole point is that we are not yet confident who is at the keyboard —
 * the account may still be holding the employee code it was provisioned with,
 * and that code is printed in the directory every colleague can read.
 */
const ALLOWED = [
  { method: 'POST', path: /^\/auth\/change-password$/ },
  { method: 'GET', path: /^\/auth\/me$/ },
  { method: 'POST', path: /^\/auth\/logout$/ },
  // 2FA status/enrolment is allowed so an account can be secured in the same
  // sitting; none of it discloses anyone else's data.
  { method: 'GET', path: /^\/auth\/2fa$/ },
  { method: 'GET', path: /^\/me\/permissions$/ },
  { method: 'GET', path: /^\/health$/ },
];

/**
 * Holds a not-yet-secured session to the endpoints above.
 *
 * Runs after JwtAuthGuard, so `request.user` is populated and its
 * `mustChangePassword` came from the database on this request — not from a
 * claim in the token, which the holder could otherwise try to strip.
 */
@Injectable()
export class FirstLoginGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user?.mustChangePassword) return true;

    const path = stripApiPrefix(request.path ?? '');
    const method = (request.method ?? 'GET').toUpperCase();
    const permitted = ALLOWED.some(
      (rule) => rule.method === method && rule.path.test(path),
    );
    if (permitted) return true;

    throw new ForbiddenException(
      'Please change your password before using DBL HRM. Your account is still using the temporary password it was set up with.',
    );
  }
}

/** `/api/auth/me` -> `/auth/me`; tolerant of a missing or different prefix. */
function stripApiPrefix(path: string): string {
  const withoutQuery = path.split('?')[0];
  return withoutQuery.replace(/^\/api(?=\/|$)/, '') || '/';
}
