import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { ROLES_KEY } from '../decorators/roles.decorator';
import { ALLOW_SUPER_USER_KEY } from '../decorators/allow-super-user.decorator';
import { AuthUser } from '../decorators/current-user.decorator';
import { PermissionsService } from '../../modules/rbac/permissions.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (user && required.includes(user.role)) return true;

    // Routes marked @AllowSuperUser() also accept the dynamic super_user role,
    // so granting super_user is enough to administer the system without also
    // handing out the static ADMIN login.
    const allowSuperUser = this.reflector.getAllAndOverride<boolean>(
      ALLOW_SUPER_USER_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (user && allowSuperUser && (await this.permissions.isSuperUser(user.id))) {
      return true;
    }

    throw new ForbiddenException('Insufficient permissions for this action');
  }
}
