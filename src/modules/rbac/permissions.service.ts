import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { MemoryCacheService } from '../../common/cache/memory-cache.service';
import { normalizeUnitName } from '../../common/util/normalize-unit';

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
const PERMS_PREFIX = 'perms:';
const PERMS_TTL = 60_000; // 60s — invalidated immediately on any role change.

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: MemoryCacheService,
  ) {}

  /** Resolve a user's effective roles + accessible units (cached). */
  getUserPermissions(userId: string): Promise<UserPermissions> {
    return this.cache.wrap(`${PERMS_PREFIX}${userId}`, PERMS_TTL, () =>
      this.loadUserPermissions(userId),
    );
  }

  private async loadUserPermissions(userId: string): Promise<UserPermissions> {
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

  /** Drop cached permissions (call on any role / assignment change). */
  invalidate(userId?: string): void {
    if (userId) this.cache.delete(`${PERMS_PREFIX}${userId}`);
    else this.cache.deleteByPrefix(PERMS_PREFIX);
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
        permissions.roles.some((role) =>
          ALL_UNIT_ACCESS_ROLE_KEYS.has(role.key),
        ),
      unitNames,
    };
  }

  async canAccessUnitName(userId: string, unitName: string): Promise<boolean> {
    const scope = await this.getUnitAccessScope(userId);
    const target = normalizeUnitName(unitName);
    return (
      scope.all ||
      scope.unitNames.some((name) => normalizeUnitName(name) === target)
    );
  }

  async isSuperUser(userId: string): Promise<boolean> {
    const perms = await this.getUserPermissions(userId);
    return perms.isSuperUser;
  }

  /**
   * Does the user hold `roleKey` for the given unit (by name)? Super users
   * always do. Answered from the cached permission set — no extra queries.
   */
  async hasRoleForUnitName(
    userId: string,
    roleKey: string,
    unitName: string,
  ): Promise<boolean> {
    const perms = await this.getUserPermissions(userId);
    if (perms.isSuperUser) return true;
    const target = normalizeUnitName(unitName);
    return perms.roles.some(
      (r) =>
        r.key === roleKey &&
        (r.unitId === null || normalizeUnitName(r.unitName) === target),
    );
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
    // Match every unit that resolves to the same name (handles "Ltd" vs "Ltd.").
    const target = normalizeUnitName(unitName);
    const units = await this.prisma.unit.findMany({
      select: { id: true, name: true },
    });
    const unitIds = units
      .filter((u) => normalizeUnitName(u.name) === target)
      .map((u) => u.id);
    return this.prisma.roleAssignment.findMany({
      where: {
        role: { key: roleKey },
        OR: [
          { unitId: null },
          ...(unitIds.length ? [{ unitId: { in: unitIds } }] : []),
        ],
      },
      include: { user: { select: { name: true } } },
    });
  }
}
