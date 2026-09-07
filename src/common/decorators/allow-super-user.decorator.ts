import { SetMetadata } from '@nestjs/common';

export const ALLOW_SUPER_USER_KEY = 'allowSuperUser';

/**
 * Let a holder of the dynamic `super_user` role through a `@Roles(...)` gate.
 *
 * Deliberately opt-in per controller rather than a blanket bypass in
 * RolesGuard: some admin-only surfaces (ZingHR sync, Google OAuth, BDJobs
 * credentials) are meant to stay with the platform administrator even when
 * other people hold super_user.
 */
export const AllowSuperUser = () => SetMetadata(ALLOW_SUPER_USER_KEY, true);
