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

/**
 * What the recruitment gate needs to know about a requisition: its unit, its
 * recruiter, and whoever is standing in for them. Shared so the gates in
 * candidates / assessment / interview / onboarding / facilities / salary all
 * pass the same thing and none of them can quietly forget the cover.
 */
export interface RecruitmentSubject {
  unitFactory: string;
  recruiterId: string | null;
  coverRecruiterId: string | null;
  coverUntil: Date | null;
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
const LEAVE_KEY = 'leave:on-leave-user-ids';
/**
 * Short: leave changes routing the moment it is set, and the writer invalidates
 * this anyway. The TTL is only a backstop for a period that expires on its own.
 */
const LEAVE_TTL = 30_000;

/**
 * The roles that may administer an employee's record.
 *
 * Editing the HR master and placing an e-signature on someone's profile are the
 * same kind of act — changing a person's record on their behalf — so both read
 * this list rather than each keeping its own copy and drifting.
 *
 * Super users bypass it, as they bypass every scope check.
 */
export const EMPLOYEE_ADMIN_ROLES = [
  'corporate_hr',
  'chro',
  'corporate_recruiter',
] as const;

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
    // The dashboard is cached per user and filtered by these permissions
    // (dashboard.service.ts), so a role change must not leave it showing what
    // the old role could see.
    if (userId) this.cache.delete(`dashboard:${userId}`);
    else this.cache.deleteByPrefix('dashboard:');
  }

  // --- who is away --------------------------------------------------------

  /**
   * Everyone on leave right now.
   *
   * One set for the whole request rather than a query per candidate: routing
   * asks this for every holder of a role, and the answer is the same for all of
   * them. A period expires by itself — `endsAt` in the past simply stops
   * matching — so nothing has to run on a schedule to put anyone back on duty.
   */
  async onLeaveUserIds(): Promise<Set<string>> {
    return new Set((await this.activeLeaves()).keys());
  }

  /**
   * Everyone on leave right now, with when they are due back (null = until
   * further notice). One cached read behind both this and `onLeaveUserIds`,
   * because the layering page wants the date and routing only wants the names.
   */
  async activeLeaves(): Promise<Map<string, { endsAt: Date | null }>> {
    const rows = await this.cache.wrap(LEAVE_KEY, LEAVE_TTL, async () => {
      const now = new Date();
      return this.prisma.leavePeriod.findMany({
        where: {
          endedAt: null,
          startsAt: { lte: now },
          OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        },
        select: { userId: true, endsAt: true },
      });
    });
    return new Map(rows.map((r) => [r.userId, { endsAt: r.endsAt }] as const));
  }

  /** Drop the cached leave set (call whenever a leave starts or ends). */
  invalidateLeave(): void {
    this.cache.delete(LEAVE_KEY);
  }

  async isOnLeave(userId: string): Promise<boolean> {
    return (await this.onLeaveUserIds()).has(userId);
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
   * `undefined` means "no restriction" (Head of Talent Acquisition / CHRO / super). Everyone
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
      // Whoever wrote the job analysis keeps sight of it afterwards — they are
      // not on the chain, so no other clause would match once it moves on.
      { jobAnalysisById: userId },
      // Addressed to them, and standing in for a recruiter on leave.
      { jobAnalysisAssigneeId: userId },
      { coverRecruiterId: userId },
    ];

    // Waiting on a job analysis in this Factory HR's units. It belongs to the
    // whole queue on duty, so every one of them sees it.
    const isFactoryHr = perms.roles.some((r) => r.key === 'factory_hr');
    // On leave, they are out of the queue: the job analyses waiting in their
    // units are the colleagues' on duty, and do not sit in their list.
    const onLeave = isFactoryHr && (await this.onLeaveUserIds()).has(userId);
    if (isFactoryHr && !onLeave && scope.unitNames.length > 0) {
      clauses.push({
        status: 'PENDING_JOB_ANALYSIS',
        jobAnalysisAssigneeId: null,
        unitFactory: { in: scope.unitNames },
      });
    }
    // A Corporate Recruiter covers only units with no Factory HR available —
    // and only the requisitions that were left unaddressed, never one sitting
    // with a named person.
    if (perms.roles.some((r) => r.key === 'corporate_recruiter')) {
      const covered = await this.unitNamesWithFactoryHr();
      clauses.push({
        status: 'PENDING_JOB_ANALYSIS',
        jobAnalysisAssigneeId: null,
        ...(covered.length > 0
          ? { NOT: { unitFactory: { in: covered } } }
          : {}),
      });
    }

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
  /**
   * May this user administer employee records — edit the HR master, or place a
   * signature on someone's profile?
   *
   * Global, not unit-scoped: the employee directory is a group-wide master and
   * these roles are held globally.
   */
  async isEmployeeAdmin(userId: string): Promise<boolean> {
    if (await this.isSuperUser(userId)) return true;
    const perms = await this.getUserPermissions(userId);
    return perms.roles.some((r) =>
      (EMPLOYEE_ADMIN_ROLES as readonly string[]).includes(r.key),
    );
  }

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
   * Units that have a Factory HR of their own, by normalised name.
   *
   * The job-analysis fallback is conditional — Corporate HR and the Corporate
   * Recruiters only step in where a unit has nobody — so both the gate and the
   * notification have to know which units those are. One query, shared, rather
   * than each caller asking its own way.
   */
  async unitNamesWithFactoryHr(): Promise<string[]> {
    const [assignments, onLeave] = await Promise.all([
      this.prisma.roleAssignment.findMany({
        where: { role: { key: 'factory_hr' } },
        select: { userId: true, unit: { select: { name: true } } },
      }),
      this.onLeaveUserIds(),
    ]);
    // Unit names as stored, not normalised: `unitFactory` on a requisition is
    // copied from a units row, so an exact match is the one that works.
    //
    // A unit whose every Factory HR is on leave counts as having none — that is
    // the whole point of the fallback, and the Corporate Recruiters covering it
    // need to see the work.
    return [
      ...new Set(
        assignments
          .filter((a) => !onLeave.has(a.userId))
          .map((a) => a.unit?.name)
          .filter((name): name is string => Boolean(name)),
      ),
    ];
  }

  /**
   * A unit's Factory HR queue, in layering order: first priority, then second,
   * and so on. Unordered holders (no priority set) come last, by name, so a unit that
   * never configured an order still gets a stable list.
   */
  async factoryHrQueue(unitName: string): Promise<
    {
      id: string;
      name: string;
      employeeCode: string;
      priority: number | null;
      onLeave: boolean;
      /** When they are due back; null while on duty or away indefinitely. */
      leaveEndsAt?: Date | null;
      /** The assignment row, so the page can reorder it. */
      assignmentId?: string;
    }[]
  > {
    const [assignments, leaves] = await Promise.all([
      this.holderAssignments('factory_hr', unitName),
      this.activeLeaves(),
    ]);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(assignments.map((a) => a.userId))] } },
      select: { id: true, name: true, employeeCode: true },
    });
    const rowOf = new Map(assignments.map((a) => [a.userId, a] as const));
    return users
      .map((u) => ({
        ...u,
        priority: rowOf.get(u.id)?.priority ?? null,
        assignmentId: rowOf.get(u.id)?.id,
        onLeave: leaves.has(u.id),
        leaveEndsAt: leaves.get(u.id)?.endsAt ?? null,
      }))
      .sort(
        (a, b) =>
          (a.priority ?? Number.MAX_SAFE_INTEGER) -
            (b.priority ?? Number.MAX_SAFE_INTEGER) ||
          a.name.localeCompare(b.name),
      );
  }

  /**
   * Who completes the Job Analysis for a unit's requisition.
   *
   * The unit's Factory HR owns it. A unit with no Factory HR of its own falls
   * back to Corporate HR and the Corporate Recruiters — deliberately a
   * FALLBACK, not a parallel route: where a Factory HR exists, it is theirs.
   */
  async jobAnalysisOwners(unitName: string): Promise<{
    /**
     * Always null now: a job analysis belongs to the whole available queue,
     * not one person. Kept in the shape for requisitions raised under the
     * old rule, whose `jobAnalysisAssigneeId` the migration released.
     */
    assigneeId: string | null;
    userIds: string[];
    /** False when nobody is available and the corporate fallback is in play. */
    viaFactoryHr: boolean;
  }> {
    const queue = await this.factoryHrQueue(unitName);
    const available = queue.filter((h) => !h.onLeave);

    if (available.length > 0) {
      // Every Factory HR on duty gets it and any of them may continue it —
      // the activity log records who actually did. It was addressed to the
      // first priority alone, which parked work behind one person's desk.
      // Somebody on leave is simply not in `available`: they are not told
      // and cannot pick it up, and the rest of the queue carries it. The
      // order is kept (it is what lists them first priority, second, …).
      return {
        assigneeId: null,
        userIds: available.map((h) => h.id),
        viaFactoryHr: true,
      };
    }

    // No Factory HR at all, or every one of them is on leave.
    const [corporateHr, recruiters] = await Promise.all([
      this.roleHolderUserIds('corporate_hr', unitName),
      this.roleHolderUserIds('corporate_recruiter', unitName),
    ]);
    return {
      assigneeId: null,
      userIds: [...new Set([...corporateHr, ...recruiters])],
      viaFactoryHr: false,
    };
  }

  /**
   * The same rule as `jobAnalysisOwners`, as named people.
   *
   * The requisition page reads this rather than working the rule out from the
   * viewer's own roles: whether the fallback is in play depends on who holds
   * Factory HR for that unit, which the browser cannot know.
   */
  async jobAnalysisOwnerHolders(unitName: string): Promise<{
    viaFactoryHr: boolean;
    holders: {
      id: string;
      name: string;
      employeeCode: string;
      /** Position in the layering, 1 first. Null on an unordered unit. */
      priority?: number | null;
      onLeave?: boolean;
    }[];
  }> {
    const queue = await this.factoryHrQueue(unitName);
    if (queue.some((h) => !h.onLeave)) {
      return { viaFactoryHr: true, holders: queue };
    }
    // Nobody in the queue is available (or there is no queue) — show who is
    // covering instead, so the page names people who can actually act.
    const [corporateHr, recruiters] = await Promise.all([
      this.roleHolders('corporate_hr', unitName),
      this.roleHolders('corporate_recruiter', unitName),
    ]);
    const onLeave = await this.onLeaveUserIds();
    const byId = new Map(
      [...corporateHr, ...recruiters].map(
        (h) => [h.id, { ...h, onLeave: onLeave.has(h.id) }] as const,
      ),
    );
    return { viaFactoryHr: false, holders: [...byId.values()] };
  }

  /**
   * May this user write the Job Analysis on a requisition in this unit?
   *
   * `assigneeId` is the requisition's own `jobAnalysisAssigneeId`: once it is
   * addressed to someone, it is theirs alone — the second in line does not get
   * to reach past them, and is moved up only when they go on leave. Null means
   * it was never addressed to a person (an unordered unit, or the fallback),
   * and then it belongs to whoever `jobAnalysisOwners` names today.
   */
  async canCompleteJobAnalysis(
    userId: string,
    unitName: string,
    assigneeId: string | null = null,
  ): Promise<boolean> {
    if (await this.isSuperUser(userId)) return true;
    if (assigneeId) return assigneeId === userId;
    const owners = await this.jobAnalysisOwners(unitName);
    return owners.userIds.includes(userId);
  }

  /** `canCompleteJobAnalysis`, but throws instead of returning false. */
  async requireJobAnalysisAccess(
    userId: string,
    unitName: string,
    assigneeId: string | null = null,
    action = 'complete the job analysis',
  ): Promise<void> {
    if (await this.canCompleteJobAnalysis(userId, unitName, assigneeId)) return;
    if (assigneeId) {
      const who = await this.prisma.user.findUnique({
        where: { id: assigneeId },
        select: { name: true },
      });
      throw new ForbiddenException(
        `This job analysis is with ${who?.name ?? 'another Factory HR'} — only they (or a super user) can ${action}. It moves to the next Factory HR in line if they go on leave.`,
      );
    }
    const owners = await this.jobAnalysisOwners(unitName);
    throw new ForbiddenException(
      owners.viaFactoryHr
        ? `Only Factory HR for ${unitName} (or a super user) can ${action}`
        : `${unitName} has no Factory HR available, so only Head of Talent Acquisition, a Corporate Recruiter or a super user can ${action}`,
    );
  }

  /**
   * Post-approval recruitment access: Head of Talent Acquisition / CHRO / super users, plus
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
    /**
     * The requisition's stand-in while its recruiter is on leave. Additive and
     * self-expiring: the recruiter keeps their own access throughout, and the
     * date is checked here rather than swept, so a cover stops counting the
     * moment the leave is over even if nothing has tidied the row yet.
     */
    cover?: { userId: string | null; until: Date | null } | null,
  ): Promise<boolean> {
    if (recruiterId && recruiterId === userId) return true;
    if (
      cover?.userId &&
      cover.userId === userId &&
      (!cover.until || cover.until.getTime() > Date.now())
    ) {
      return true;
    }
    return (
      (await this.hasRoleForUnitName(userId, 'corporate_hr', unitName)) ||
      (await this.hasRoleForUnitName(userId, 'chro', unitName))
    );
  }

  /**
   * Has this user been handed interview work here?
   *
   * Head of Talent Acquisition / the recruiter can delegate shortlisted candidates to
   * someone (typically factory-side) to run the first interview. That person
   * holds no recruitment role, so every gate below the delegation has to
   * consult this or they are locked out of the job they were given.
   *
   * Pass `candidateId` for candidate-scoped work, or `requisitionId` for work
   * that hangs off the requisition rather than one candidate — forming the
   * interview committee, most of all. A delegation on any candidate in a
   * requisition qualifies them for that requisition's committee, because the
   * committee is what they were asked to arrange.
   */
  async hasInterviewDelegation(
    userId: string,
    where: { candidateId?: string; requisitionId?: string },
  ): Promise<boolean> {
    if (!where.candidateId && !where.requisitionId) return false;
    const row = await this.prisma.interviewDelegation.findFirst({
      where: {
        delegatedToId: userId,
        revokedAt: null,
        ...(where.candidateId ? { candidateId: where.candidateId } : {}),
        ...(where.requisitionId ? { requisitionId: where.requisitionId } : {}),
      },
      select: { id: true },
    });
    return Boolean(row);
  }

  /** `canRunRecruitment`, but throws instead of returning false. */
  async requireRecruitmentAccess(
    userId: string,
    unitName: string,
    recruiterId: string | null,
    action = 'access recruitment for this requisition',
    cover?: { userId: string | null; until: Date | null } | null,
  ): Promise<void> {
    if (await this.canRunRecruitment(userId, unitName, recruiterId, cover))
      return;
    throw new ForbiddenException(
      `Only Head of Talent Acquisition, CHRO, the assigned recruiter (or whoever is covering for them) or a super user can ${action}`,
    );
  }

  /**
   * Who to notify about a requisition's post-approval activity: Head of Talent Acquisition
   * for that unit, plus the assigned recruiter (who owns it day to day).
   */
  async recruitmentRecipients(
    unitName: string,
    recruiterId: string | null,
    cover?: { userId: string | null; until: Date | null } | null,
  ): Promise<string[]> {
    const ids = await this.roleHolderUserIds('corporate_hr', unitName);
    const add = (id: string | null | undefined) => {
      if (id && !ids.includes(id)) ids.push(id);
    };
    add(recruiterId);
    // The stand-in too, while the cover lasts — they are the one acting on it.
    if (!cover?.until || (cover.until?.getTime() ?? 0) > Date.now()) {
      add(cover?.userId);
    }
    return ids;
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
