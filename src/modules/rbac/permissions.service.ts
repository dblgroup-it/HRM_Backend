import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface EffectiveRole {
  key: string;
  name: string;
  scope: string;
  unitId: string | null;
  unitName: string | null;
}

export interface UserPermissions {
  isSuperUser: boolean;
  roles: EffectiveRole[];
  /** Distinct unit ids the user has any role for (empty if only global). */
  unitIds: string[];
}

export interface UnitAccessScope {
  all: boolean;
  unitNames: string[];
}

const ALL_UNIT_ACCESS_ROLE_KEYS = new Set(['corporate_hr', 'chro']);

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve a user's effective roles + accessible units. */
  async getUserPermissions(userId: string): Promise<UserPermissions> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roleAssignments: { include: { role: true, unit: true } } },
    });
    if (!user) return { isSuperUser: false, roles: [], unitIds: [] };

    const isSuperUser =
      user.role === 'ADMIN' ||
      user.roleAssignments.some((a) => a.role.key === 'super_user');

    const roles: EffectiveRole[] = user.roleAssignments.map((a) => ({
      key: a.role.key,
      name: a.role.name,
      scope: a.role.scope,
      unitId: a.unitId,
      unitName: a.unit?.name ?? null,
    }));

    const unitIds = [
      ...new Set(
        user.roleAssignments
          .map((a) => a.unitId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    return { isSuperUser, roles, unitIds };
  }

  /** Resolve whether a user can see every unit or only their assigned units. */
  async getUnitAccessScope(userId: string): Promise<UnitAccessScope> {
    const permissions = await this.getUserPermissions(userId);
    const unitNames = [
      ...new Set(
        permissions.roles
          .map((role) => role.unitName)
          .filter((unitName): unitName is string => Boolean(unitName)),
      ),
    ];

    return {
      all:
        permissions.isSuperUser ||
        permissions.roles.some((role) => ALL_UNIT_ACCESS_ROLE_KEYS.has(role.key)),
      unitNames,
    };
  }

  async canAccessUnitName(userId: string, unitName: string): Promise<boolean> {
    const scope = await this.getUnitAccessScope(userId);
    return (
      scope.all ||
      scope.unitNames.some(
        (name) => name.toLowerCase() === unitName.toLowerCase(),
      )
    );
  }

  async isSuperUser(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roleAssignments: { include: { role: true } } },
    });
    return (
      !!user &&
      (user.role === 'ADMIN' ||
        user.roleAssignments.some((a) => a.role.key === 'super_user'))
    );
  }

  /** Does the user hold `roleKey` for the given unit (by name)? Super users always do. */
  async hasRoleForUnitName(
    userId: string,
    roleKey: string,
    unitName: string,
  ): Promise<boolean> {
    if (await this.isSuperUser(userId)) return true;

    const unit = await this.prisma.unit.findFirst({
      where: { name: { equals: unitName, mode: 'insensitive' } },
      select: { id: true },
    });

    const where: Prisma.RoleAssignmentWhereInput = {
      userId,
      role: { key: roleKey },
      OR: [{ unitId: null }, ...(unit ? [{ unitId: unit.id }] : [])],
    };
    const found = await this.prisma.roleAssignment.findFirst({ where });
    return !!found;
  }

  /** Names of users holding `roleKey` for a unit (global holders included). */
  async roleHolderNames(roleKey: string, unitName: string): Promise<string[]> {
    const assignments = await this.holderAssignments(roleKey, unitName);
    return [...new Set(assignments.map((a) => a.user.name))];
  }

  /** User ids holding `roleKey` for a unit — used to target notifications. */
  async roleHolderUserIds(
    roleKey: string,
    unitName: string,
  ): Promise<string[]> {
    const assignments = await this.holderAssignments(roleKey, unitName);
    return [...new Set(assignments.map((a) => a.userId))];
  }

  private async holderAssignments(roleKey: string, unitName: string) {
    const unit = await this.prisma.unit.findFirst({
      where: { name: { equals: unitName, mode: 'insensitive' } },
      select: { id: true },
    });
    return this.prisma.roleAssignment.findMany({
      where: {
        role: { key: roleKey },
        OR: [{ unitId: null }, ...(unit ? [{ unitId: unit.id }] : [])],
      },
      include: { user: { select: { name: true } } },
    });
  }
}
