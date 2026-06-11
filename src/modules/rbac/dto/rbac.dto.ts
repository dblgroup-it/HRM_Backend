import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { RoleScope } from '@prisma/client';

export class CreateRoleDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(RoleScope)
  scope!: RoleScope;
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(RoleScope)
  scope?: RoleScope;
}

export class CreateAssignmentDto {
  @IsString()
  roleId!: string;

  @IsString()
  userId!: string;

  /** Required for UNIT-scoped roles; omit for GLOBAL roles. */
  @IsOptional()
  @IsString()
  unitId?: string;
}
