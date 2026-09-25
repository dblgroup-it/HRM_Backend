import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from './permissions.service';
import { sameUnit } from '../../common/util/normalize-unit';
import { LAYERED_ROLE_KEYS, layerOrder } from './layering';
import {
  CreateAssignmentDto,
  CreateRoleDto,
  UpdateRoleDto,
  SetLayeringOrderDto,
} from './dto/rbac.dto';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  // --- Roles --------------------------------------------------------------

  listRoles() {
    return this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { assignments: true } } },
    });
  }

  async createRole(dto: CreateRoleDto, userId: string) {
    const key = slugify(dto.name);
    if (!key) throw new BadRequestException('Invalid role name');
    try {
      return await this.prisma.role.create({
        data: {
          key,
          name: dto.name,
          description: dto.description,
          scope: dto.scope,
          createdById: userId,
          updatedById: userId,
        },
      });
    } catch (e) {
      throw this.handleUnique(e, 'A role with that name already exists');
    }
  }

  async updateRole(id: string, dto: UpdateRoleDto, userId: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    try {
      const updated = await this.prisma.role.update({
        where: { id },
        data: {
          ...(dto.name ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.scope ? { scope: dto.scope } : {}),
          updatedById: userId,
        },
      });
      this.permissions.invalidate();
      return updated;
    } catch (e) {
      throw this.handleUnique(e, 'A role with that name already exists');
    }
  }

  async deleteRole(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) {
      throw new ForbiddenException('System roles cannot be deleted');
    }
    await this.prisma.role.delete({ where: { id } });
    this.permissions.invalidate();
    return { id };
  }

  // --- Assignments --------------------------------------------------------

  /**
   * Every assignment, with one derived flag: whether a Requisition Raiser
   * actually has an approval path in that unit.
   *
   * Holding the role without a path is a dead end — `buildStepsForRaiser`
   * refuses, so the person is told to ask Corporate HR the moment they try to
   * raise. Access Control used to show the role and say nothing, which read as
   * "they can raise here".
   */
  async listAssignments(filters: { roleId?: string; unitId?: string }) {
    const [rows, paths] = await Promise.all([
      this.findAssignments(filters),
      this.prisma.approvalPath.findMany({
        select: { unitId: true, raiserId: true },
      }),
    ]);
    const routed = new Set(paths.map((p) => `${p.unitId}:${p.raiserId}`));
    return rows.map((a) => ({
      ...a,
      hasApprovalPath:
        a.role.key === 'requisition_raiser' && a.unitId
          ? routed.has(`${a.unitId}:${a.userId}`)
          : null,
    }));
  }

  private findAssignments(filters: { roleId?: string; unitId?: string }) {
    return this.prisma.roleAssignment.findMany({
      where: {
        ...(filters.roleId ? { roleId: filters.roleId } : {}),
        ...(filters.unitId ? { unitId: filters.unitId } : {}),
      },
      include: {
        role: true,
        unit: true,
        user: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            employee: { select: { designation: true, department: true } },
          },
        },
      },
      // Priority order first (1, 2, 3…), unordered holders after it. The page
      // shows the queue, so it has to arrive as a queue.
      orderBy: [{ priority: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
  }

  async createAssignment(dto: CreateAssignmentDto, assignedById: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role) throw new NotFoundException('Role not found');

    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!user) throw new NotFoundException('Employee (user) not found');

    if (role.scope === 'UNIT' && !dto.unitId) {
      throw new BadRequestException(
        `Role "${role.name}" is unit-scoped — a unit is required`,
      );
    }
    const unitId = role.scope === 'GLOBAL' ? null : (dto.unitId ?? null);

    if (unitId) {
      const unit = await this.prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit) throw new NotFoundException('Unit not found');
    }

    try {
      const created = await this.prisma.roleAssignment.create({
        data: { roleId: dto.roleId, userId: dto.userId, unitId, assignedById },
        include: { role: true, unit: true, user: { select: { name: true } } },
      });
      this.permissions.invalidate(dto.userId);
      // A new Factory HR joins the end of the unit's layering.
      if (unitId && LAYERED_ROLE_KEYS.includes(role.key)) {
        await this.renumberLayer(dto.roleId, unitId);
        return (
          (await this.prisma.roleAssignment.findUnique({
            where: { id: created.id },
            include: {
              role: true,
              unit: true,
              user: { select: { name: true } },
            },
          })) ?? created
        );
      }
      return created;
    } catch (e) {
      throw this.handleUnique(e, 'This person already holds that role here');
    }
  }

  /**
   * Everything the HR Layering page shows: each unit's Factory HR queue in
   * priority order with who is away, and the Corporate Recruiter pool.
   *
   * Assembled here rather than in the page so the order shown is the same one
   * routing actually uses — `factoryHrQueue` is what addresses a requisition.
   */
  async hrLayering() {
    const units = await this.prisma.unit.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });

    const withQueues = await Promise.all(
      units.map(async (u) => ({
        unitId: u.id,
        unitName: u.name,
        queue: await this.permissions.factoryHrQueue(u.name),
      })),
    );

    // Corporate Recruiter is a GLOBAL role, so the pool is the same everywhere
    // — listed once rather than repeated under every unit.
    const [recruiters, leaves] = await Promise.all([
      this.permissions.roleHolders('corporate_recruiter', ''),
      this.permissions.activeLeaves(),
    ]);

    return {
      // Units with nobody are still listed: "no Factory HR here" is the thing
      // the page most needs to make obvious.
      units: withQueues.map((u) => ({
        ...u,
        queue: u.queue.map((h) => ({
          assignmentId: h.assignmentId ?? null,
          userId: h.id,
          name: h.name,
          employeeCode: h.employeeCode,
          priority: h.priority,
          onLeave: h.onLeave,
          leaveEndsAt: h.leaveEndsAt?.toISOString() ?? null,
        })),
      })),
      recruiters: recruiters.map((r) => ({
        userId: r.id,
        name: r.name,
        employeeCode: r.employeeCode,
        onLeave: leaves.has(r.id),
        leaveEndsAt: leaves.get(r.id)?.endsAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Set a unit's HR layering — the priority order for a role, Factory HR today.
   *
   * The order decides who a requisition's job analysis is addressed to: first
   * priority, unless they are on leave, then the next. Sent as the whole list so
   * it can never end up with two firsts; anyone left out is unordered and only
   * picks work up when nobody in the order is available.
   */
  async setLayeringOrder(dto: SetLayeringOrderDto) {
    const assignments = await this.prisma.roleAssignment.findMany({
      where: { roleId: dto.roleId, unitId: dto.unitId },
      select: { id: true, userId: true },
    });
    const known = new Set(assignments.map((a) => a.id));
    const unknown = dto.assignmentIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new BadRequestException(
        'That priority order refers to assignments that are not in this unit',
      );
    }

    const rank = new Map(dto.assignmentIds.map((id, i) => [id, i + 1] as const));
    await this.prisma.$transaction(
      assignments.map((a) =>
        this.prisma.roleAssignment.update({
          where: { id: a.id },
          data: { priority: rank.get(a.id) ?? null },
        }),
      ),
    );
    // Routing reads the order straight away.
    for (const a of assignments) this.permissions.invalidate(a.userId);
    return { ok: true };
  }

  /**
   * Remove an assignment — and whatever it was holding up in Approval Paths.
   *
   * The two pages are one decision seen from two sides: a raiser's chain is
   * their role made concrete, and a level naming somebody is why they were
   * given `unit_approver` in the first place. Leaving the path behind meant a
   * requisition could route to a person who can no longer sign in, and the
   * config claimed access the roles no longer granted.
   *
   * Requisitions already in flight are untouched: their chain was snapshotted
   * when they were raised, which is the whole point of snapshotting it.
   */
  async deleteAssignment(id: string) {
    const assignment = await this.prisma.roleAssignment.findUnique({
      where: { id },
      include: { role: true, unit: { select: { name: true } } },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    const removed = { paths: 0, levels: 0, jobAnalyses: 0 };
    const { userId, unitId, role } = assignment;

    if (unitId && role.key === 'requisition_raiser') {
      // Their chain in that unit is theirs alone — nobody else routes through
      // it, so it goes with the role.
      const { count } = await this.prisma.approvalPath.deleteMany({
        where: { unitId, raiserId: userId },
      });
      removed.paths = count;
    }

    if (unitId && role.key === 'unit_approver') {
      const levels = await this.prisma.approvalPathLevel.findMany({
        where: { userId, path: { unitId } },
        select: { id: true, pathId: true },
      });
      if (levels.length > 0) {
        await this.prisma.approvalPathLevel.deleteMany({
          where: { id: { in: levels.map((l) => l.id) } },
        });
        removed.levels = levels.length;
        // Close the gaps: `buildStepsForRaiser` copies orderIndex onto the
        // requisition's steps and appends Corporate HR at `steps.length`, so a
        // hole in the sequence would collide with that final step.
        await this.reindexPaths([...new Set(levels.map((l) => l.pathId))]);
      }
    }

    if (unitId && role.key === 'factory_hr' && assignment.unit) {
      // A job analysis addressed to them by name (the old rule, or a leave
      // hand-over) would otherwise stay theirs — on their dashboard and in
      // their list — after they stop being Factory HR. Released to the
      // unit's queue, which is where every new one goes anyway.
      const addressed = await this.prisma.requisition.findMany({
        where: {
          status: 'PENDING_JOB_ANALYSIS',
          jobAnalysisAssigneeId: userId,
        },
        select: { id: true, unitFactory: true },
      });
      const ids = addressed
        .filter((r) => sameUnit(r.unitFactory, assignment.unit!.name))
        .map((r) => r.id);
      if (ids.length) {
        const { count } = await this.prisma.requisition.updateMany({
          where: { id: { in: ids } },
          data: { jobAnalysisAssigneeId: null },
        });
        removed.jobAnalyses = count;
      }
    }

    await this.prisma.roleAssignment.delete({ where: { id } });
    this.permissions.invalidate(userId);
    // Close the gap in the unit's layering: 2 and 3 become 1 and 2.
    if (unitId && LAYERED_ROLE_KEYS.includes(role.key)) {
      await this.renumberLayer(assignment.roleId, unitId);
    }
    return { id, removed };
  }

  /** Number a unit's layered holders 1..n, keeping their order — see layering.ts. */
  private async renumberLayer(roleId: string, unitId: string): Promise<void> {
    const rows = await this.prisma.roleAssignment.findMany({
      where: { roleId, unitId },
      select: { id: true, userId: true, priority: true, createdAt: true },
    });
    const order = layerOrder(rows);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const changed = order
      .map((id, i) => ({ id, priority: i + 1 }))
      .filter((r) => byId.get(r.id)!.priority !== r.priority);
    if (!changed.length) return;
    await this.prisma.$transaction(
      changed.map((r) =>
        this.prisma.roleAssignment.update({
          where: { id: r.id },
          data: { priority: r.priority },
        }),
      ),
    );
    for (const r of rows) this.permissions.invalidate(r.userId);
  }

  /** Renumber a path's levels 0..n-1, preserving their order. */
  private async reindexPaths(pathIds: string[]): Promise<void> {
    for (const pathId of pathIds) {
      const levels = await this.prisma.approvalPathLevel.findMany({
        where: { pathId },
        orderBy: { orderIndex: 'asc' },
        select: { id: true },
      });
      await this.prisma.$transaction([
        // Two passes: orderIndex is unique per path, so shifting down in place
        // would collide with a row that has not moved yet.
        ...levels.map((l, i) =>
          this.prisma.approvalPathLevel.update({
            where: { id: l.id },
            data: { orderIndex: -(i + 1) },
          }),
        ),
        ...levels.map((l, i) =>
          this.prisma.approvalPathLevel.update({
            where: { id: l.id },
            data: { orderIndex: i },
          }),
        ),
      ]);
    }
  }

  private handleUnique(e: unknown, message: string): Error {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return new ConflictException(message);
    }
    return e as Error;
  }
}
