import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../../common/decorators/roles.decorator';
import { AllowSuperUser } from '../../common/decorators/allow-super-user.decorator';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RbacService } from './rbac.service';
import { PermissionsService } from './permissions.service';
import { AccessNoticeService } from './access-notice.service';
import {
  CreateAssignmentDto,
  CreateRoleDto,
  SetLayeringOrderDto,
  UpdateRoleDto,
} from './dto/rbac.dto';

@AllowSuperUser()
@Controller()
export class RbacController {
  constructor(
    private readonly rbac: RbacService,
    private readonly permissions: PermissionsService,
    private readonly accessNotice: AccessNoticeService,
  ) {}

  // --- current user permissions (any authenticated user) ------------------

  @Get('me/permissions')
  myPermissions(@CurrentUser() user: AuthUser) {
    return this.permissions.getUserPermissions(user.id);
  }

  // --- roles (admin) ------------------------------------------------------

  @Roles(UserRole.ADMIN)
  @Get('roles')
  listRoles() {
    return this.rbac.listRoles();
  }

  @Roles(UserRole.ADMIN)
  @Post('roles')
  createRole(@Body() dto: CreateRoleDto, @CurrentUser() user: AuthUser) {
    return this.rbac.createRole(dto, user.id);
  }

  @Roles(UserRole.ADMIN)
  @Patch('roles/:id')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rbac.updateRole(id, dto, user.id);
  }

  @Roles(UserRole.ADMIN)
  @Delete('roles/:id')
  deleteRole(@Param('id') id: string) {
    return this.rbac.deleteRole(id);
  }

  // --- assignments (admin) ------------------------------------------------

  @Roles(UserRole.ADMIN)
  @Get('role-assignments')
  listAssignments(
    @Query('roleId') roleId?: string,
    @Query('unitId') unitId?: string,
  ) {
    return this.rbac.listAssignments({ roleId, unitId });
  }

  @Roles(UserRole.ADMIN)
  @Post('role-assignments')
  createAssignment(
    @Body() dto: CreateAssignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rbac.createAssignment(dto, user.id);
  }

  @Roles(UserRole.ADMIN)
  /** Each unit's Factory HR queue + the recruiter pool, with who is away. */
  @Roles(UserRole.ADMIN)
  @Get('hr-layering')
  hrLayering() {
    return this.rbac.hrLayering();
  }

  /** Set a unit's priority order for a role (first priority, second, …). */
  @Roles(UserRole.ADMIN)
  @Patch('role-assignments/order')
  setLayeringOrder(@Body() dto: SetLayeringOrderDto) {
    return this.rbac.setLayeringOrder(dto);
  }

  // Admin-only like granting: it was the one Access Control route without a
  // guard, so any signed-in user could remove anybody's role.
  @Roles(UserRole.ADMIN)
  @Delete('role-assignments/:id')
  deleteAssignment(@Param('id') id: string) {
    return this.rbac.deleteAssignment(id);
  }

  /**
   * Everyone who can sign in and still holds the default password: how many
   * would be emailed, who has no address, and the last bulk send.
   */
  @Roles(UserRole.ADMIN)
  @Get('access-notices/default-password')
  defaultPasswordAudience() {
    return this.accessNotice.defaultPasswordAudience();
  }

  /** The bulk send's progress — cheap, polled while it runs. */
  @Roles(UserRole.ADMIN)
  @Get('access-notices/default-password/run')
  defaultPasswordRun() {
    return { run: this.accessNotice.defaultPasswordRun() };
  }

  /** Email each of them their sign-in details, in the background. */
  @Roles(UserRole.ADMIN)
  @Post('access-notices/default-password')
  sendDefaultPasswordNotices(@CurrentUser() user: AuthUser) {
    return this.accessNotice.sendDefaultPasswordNotices({
      id: user.id,
      name: user.name,
    });
  }
}
