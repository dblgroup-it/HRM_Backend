import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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

/**
 * RBAC role key -> the ApprovalRole a legacy, role-routed step carries.
 *
 * Chains raised before configurable approval paths route by role rather than by
 * named person, so their steps have `approverUserId = null`. Without this map a
 * unit-scoped approver would lose sight of an in-flight requisition still
 * waiting on them. `requisition_raiser` maps to DEPARTMENT_HEAD because that is
 * the same role under its old name.
 */
const LEGACY_STEP_ROLE_BY_KEY: Record<string, string> = {
  requisition_raiser: 'DEPARTMENT_HEAD',
  factory_hr: 'FACTORY_HR',
  sbu_head: 'SBU_HEAD',
  corporate_hr: 'CORPORATE_HR',
  chro: 'CHRO',
};
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

  /**
   * Units whose ORGANISATIONAL stats (headcount, seats, departments) a user may
   * see on the dashboard.
   *
   * Deliberately broader than `getUnitAccessScope`: a GLOBAL role works across
   * the whole group by nature — a Corporate Recruiter recruits wherever they're
   * assigned, a Medical Officer clears candidates for every unit — but holds no
   * unit-scoped assignment, so unit-name filtering would return `in: []` and
   * hand them an all-zero dashboard.
   */
  async getOrgStatsScope(userId: string): Promise<UnitAccessScope> {
    const perms = await this.getUserPermissions(userId);
    if (perms.isSuperUser || perms.roles.some((r) => r.scope === 'GLOBAL')) {
      return { all: true, unitNames: [] };
    }
    return this.getUnitAccessScope(userId);
  }

  /**
   * Which requisitions this user may see, as a Prisma filter.
   *
   * `undefined` means "no restriction" (Corporate HR / CHRO / super). Everyone
   * else sees only their own business: what they raised, what they're named on
   * the chain of, and what they're recruiting for. Holding a unit-scoped role
   * is deliberately NOT enough — a raiser shouldn't see a colleague's
   * requisition just because they share a unit.
   *
   * Shared by the requisition list, its stat tiles and the dashboard so the
   * three can never disagree about what a user is allowed to count.
   */
  async requisitionVisibility(
    userId: string,
  ): Promise<Prisma.RequisitionWhereInput | undefined> {
    const scope = await this.getUnitAccessScope(userId);
    if (scope.all) return undefined;

    const perms = await this.getUserPermissions(userId);
    const legacyRoles = [
      ...new Set(
        perms.roles
          .map((r) => LEGACY_STEP_ROLE_BY_KEY[r.key])
          .filter((v): v is string => Boolean(v)),
      ),
    ];

    const clauses: Prisma.RequisitionWhereInput[] = [
      { raisedById: userId },
      { approvalSteps: { some: { approverUserId: userId } } },
      { recruiterId: userId },
    ];

    // Legacy chains route by role, so also surface anything in this user's
    // units that has a role-routed step they could act on.
    if (legacyRoles.length > 0 && scope.unitNames.length > 0) {
      clauses.push({
        AND: [
          { unitFactory: { in: scope.unitNames } },
          {
            approvalSteps: {
              some: {
                approverUserId: null,
                role: { in: legacyRoles as never },
              },
            },
          },
        ],
      });
    }

    return { OR: clauses };
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

  /**
   * Post-approval recruitment access: Corporate HR / CHRO / super users, plus
   * the Corporate Recruiter assigned to this specific requisition.
   *
   * Pass the requisition's `recruiterId` so the assigned recruiter is let
   * through. Access is additive — assigning a recruiter never removes anyone
   * else's access, it just gives the owner theirs.
   */
  async canRunRecruitment(
    userId: string,
    unitName: string,
    recruiterId: string | null,
  ): Promise<boolean> {
    if (recruiterId && recruiterId === userId) return true;
    return (
      (await this.hasRoleForUnitName(userId, 'corporate_hr', unitName)) ||
      (await this.hasRoleForUnitName(userId, 'chro', unitName))
    );
  }

  /** `canRunRecruitment`, but throws instead of returning false. */
  async requireRecruitmentAccess(
    userId: string,
    unitName: string,
    recruiterId: string | null,
    action = 'access recruitment for this requisition',
  ): Promise<void> {
    if (await this.canRunRecruitment(userId, unitName, recruiterId)) return;
    throw new ForbiddenException(
      `Only Corporate HR, CHRO, the assigned recruiter or a super user can ${action}`,
    );
  }

  /**
   * Who to notify about a requisition's post-approval activity: Corporate HR
   * for that unit, plus the assigned recruiter (who owns it day to day).
   */
  async recruitmentRecipients(
    unitName: string,
    recruiterId: string | null,
  ): Promise<string[]> {
    const ids = await this.roleHolderUserIds('corporate_hr', unitName);
    return recruiterId && !ids.includes(recruiterId)
      ? [...ids, recruiterId]
      : ids;
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

  /**
   * Holders of `roleKey` for a unit, as pickable people (id, name, code).
   * Unlike the admin-only role-assignments endpoint, this is safe to expose to
   * anyone who legitimately needs to choose among a role's holders.
   */
  async roleHolders(
    roleKey: string,
    unitName: string,
  ): Promise<{ id: string; name: string; employeeCode: string }[]> {
    const assignments = await this.holderAssignments(roleKey, unitName);
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(assignments.map((a) => a.userId))] },
        status: 'ACTIVE',
      },
      select: { id: true, name: true, employeeCode: true },
      orderBy: { name: 'asc' },
    });
    return users;
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
