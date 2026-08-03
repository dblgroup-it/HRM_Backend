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
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RbacService } from './rbac.service';
import { PermissionsService } from './permissions.service';
import {
  CreateAssignmentDto,
  CreateRoleDto,
  UpdateRoleDto,
} from './dto/rbac.dto';

@Controller()
export class RbacController {
  constructor(
    private readonly rbac: RbacService,
    private readonly permissions: PermissionsService,
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
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() user: AuthUser) {
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
  createAssignment(@Body() dto: CreateAssignmentDto, @CurrentUser() user: AuthUser) {
    return this.rbac.createAssignment(dto, user.id);
  }

  @Roles(UserRole.ADMIN)
  @Delete('role-assignments/:id')
  deleteAssignment(@Param('id') id: string) {
    return this.rbac.deleteAssignment(id);
  }
}
