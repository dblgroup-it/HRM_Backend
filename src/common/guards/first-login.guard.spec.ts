import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { FirstLoginGuard, stripApiPrefix } from './first-login.guard';

/**
 * A session that must still change its password reaches only a handful of
 * endpoints — and those have to be found whether the app calls them as
 * /api/… or, as it has since the API was versioned, /api/v1/….
 */

const guard = new FirstLoginGuard({
  getAllAndOverride: () => false,
} as unknown as Reflector);

function attempt(method: string, path: string, mustChangePassword = true) {
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ method, path, user: { mustChangePassword } }),
    }),
  } as unknown as ExecutionContext;
  return () => guard.canActivate(context);
}

describe('FirstLoginGuard', () => {
  it('lets a reset account change its password, by either address', () => {
    expect(attempt('POST', '/api/v1/auth/change-password')()).toBe(true);
    expect(attempt('POST', '/api/auth/change-password')()).toBe(true);
  });

  it('lets it see who it is and sign out, as the app does on load', () => {
    for (const [method, path] of [
      ['GET', '/api/v1/auth/me'],
      ['GET', '/api/v1/me/permissions'],
      ['POST', '/api/v1/auth/logout'],
      ['GET', '/api/v1/auth/2fa'],
    ]) {
      expect(attempt(method, path)()).toBe(true);
    }
  });

  it('keeps everything else closed until the password is changed', () => {
    for (const path of [
      '/api/v1/candidates/abc',
      '/api/v1/employees',
      '/api/requisitions',
      // Not fooled by a lookalike.
      '/api/v1/auth/change-password/extra',
    ]) {
      expect(attempt('GET', path)).toThrow(ForbiddenException);
    }
    expect(attempt('GET', '/api/v1/auth/change-password')).toThrow(
      ForbiddenException,
    );
  });

  it('does not touch an account that has chosen its password', () => {
    expect(attempt('GET', '/api/v1/candidates/abc', false)()).toBe(true);
  });
});

describe('stripApiPrefix', () => {
  it('drops the prefix and the version', () => {
    expect(stripApiPrefix('/api/v1/auth/me')).toBe('/auth/me');
    expect(stripApiPrefix('/api/v2/auth/me')).toBe('/auth/me');
    expect(stripApiPrefix('/api/auth/me')).toBe('/auth/me');
    expect(stripApiPrefix('/api/v1/auth/me?x=1')).toBe('/auth/me');
  });

  it('leaves a path without the prefix alone', () => {
    expect(stripApiPrefix('/auth/me')).toBe('/auth/me');
    expect(stripApiPrefix('/apiary/x')).toBe('/apiary/x');
    expect(stripApiPrefix('/api')).toBe('/');
  });
});
