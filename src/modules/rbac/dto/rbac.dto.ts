import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
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

/**
 * A unit's HR layering for one role — the whole list, in priority order, rather
 * than one person's number at a time. Sent whole so the result is always 1..n
 * with no gaps and no two people claiming to be first.
 */
export class SetLayeringOrderDto {
  @IsString()
  roleId!: string;

  @IsString()
  unitId!: string;

  /** Assignment ids, first priority first. Anyone left out is unordered. */
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  assignmentIds!: string[];
}
