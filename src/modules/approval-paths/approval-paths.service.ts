import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { sameUnit } from '../../common/util/normalize-unit';
import { ReplaceApprovalPathDto } from './dto/approval-path.dto';

/** Only these roles (plus super users) may configure approval paths. */
const CONFIG_ROLE_KEYS = ['corporate_hr', 'chro'];

/** The final step appended to every chain — see `buildStepsForRaiser`. */
const CORPORATE_HR_STEP = {
  title: 'Corporate HR',
  subtitle: 'Final approval to commence hiring',
};

const levelInclude = {
  levels: {
    orderBy: { orderIndex: 'asc' },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          employeeCode: true,
          employee: { select: { designation: true, department: true } },
        },
      },
    },
  },
  raiser: {
    select: {
      id: true,
      name: true,
      employeeCode: true,
      employee: { select: { designation: true, department: true } },
    },
  },
} satisfies Prisma.ApprovalPathInclude;

type PathWithLevels = Prisma.ApprovalPathGetPayload<{
  include: typeof levelInclude;
}>;

@Injectable()
export class ApprovalPathsService {
  private readonly logger = new Logger(ApprovalPathsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  // --- access -------------------------------------------------------------

  /** Configuring approval paths is Corporate HR / CHRO / super only. */
  private async requireConfigAccess(userId: string): Promise<void> {
    if (await this.permissions.isSuperUser(userId)) return;
    const perms = await this.permissions.getUserPermissions(userId);
    const allowed = perms.roles.some((r) => CONFIG_ROLE_KEYS.includes(r.key));
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can configure approval paths',
      );
    }
  }

  // --- reads --------------------------------------------------------------

  /** Every unit with its nominated raisers and each raiser's chain. */
  async findAll(userId: string) {
    await this.requireConfigAccess(userId);
    const units = await this.prisma.unit.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        approvalPaths: { include: levelInclude, orderBy: { createdAt: 'asc' } },
      },
    });
    return units.map((u) => ({
      unitId: u.id,
      unitName: u.name,
      raisers: u.approvalPaths.map((p) => serializePath(u.id, u.name, p)),
    }));
  }

  // --- write --------------------------------------------------------------

  /**
   * Nominate someone as a Requisition Raiser for a unit, creating their (empty)
   * approval path. An empty path is valid — it means their requisitions go
   * straight to Corporate HR.
   */
  async addRaiser(unitId: string, raiserId: string, userId: string) {
    await this.requireConfigAccess(userId);

    const unit = await this.prisma.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new NotFoundException('Unit not found');

    const raiser = await this.prisma.user.findUnique({
      where: { id: raiserId },
      select: { id: true, name: true, status: true },
    });
    if (!raiser) throw new NotFoundException('Person not found');
    if (raiser.status !== 'ACTIVE') {
      throw new BadRequestException(`${raiser.name} is not an active user`);
    }

    const existing = await this.prisma.approvalPath.findUnique({
      where: { unitId_raiserId: { unitId, raiserId } },
    });
    if (existing) {
      throw new BadRequestException(
        `${raiser.name} is already a requisition raiser for ${unit.name}`,
      );
    }

    await this.prisma.approvalPath.create({
      data: { unitId, raiserId, updatedById: userId },
    });

    // Being nominated here IS the grant — no separate Access Control step.
    await this.grantRole('requisition_raiser', raiserId, unitId, unit.name, userId);

    return this.findOne(unitId, raiserId, userId);
  }

  /** Stop someone raising for a unit, and drop their chain. */
  async removeRaiser(unitId: string, raiserId: string, userId: string) {
    await this.requireConfigAccess(userId);
    await this.prisma.approvalPath.deleteMany({ where: { unitId, raiserId } });
    // The requisition_raiser role assignment is deliberately left in place —
    // same rule as approvers: revoking access is a manual Access Control call,
    // since they may still appear on in-flight requisitions.
    return { success: true };
  }

  async findOne(unitId: string, raiserId: string, userId: string) {
    await this.requireConfigAccess(userId);
    const unit = await this.prisma.unit.findUnique({
      where: { id: unitId },
      select: { id: true, name: true },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    const path = await this.prisma.approvalPath.findUnique({
      where: { unitId_raiserId: { unitId, raiserId } },
      include: levelInclude,
    });
    if (!path) throw new NotFoundException('Approval path not found');
    return serializePath(unit.id, unit.name, path);
  }

  /** Replace one raiser's intermediate approvers with the given ordered list. */
  async replace(
    unitId: string,
    raiserId: string,
    dto: ReplaceApprovalPathDto,
    userId: string,
  ) {
    await this.requireConfigAccess(userId);

    const unit = await this.prisma.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new NotFoundException('Unit not found');

    const path = await this.prisma.approvalPath.findUnique({
      where: { unitId_raiserId: { unitId, raiserId } },
    });
    if (!path) {
      throw new NotFoundException(
        'That person is not a requisition raiser for this unit',
      );
    }

    await this.validateLevels(dto.levels, raiserId);

    await this.prisma.$transaction(async (tx) => {
      await tx.approvalPathLevel.deleteMany({ where: { pathId: path.id } });
      if (dto.levels.length > 0) {
        await tx.approvalPathLevel.createMany({
          data: dto.levels.map((level, orderIndex) => ({
            pathId: path.id,
            orderIndex,
            userId: level.userId,
            title: level.title.trim(),
            subtitle: level.subtitle?.trim() ?? '',
          })),
        });
      }
      await tx.approvalPath.update({
        where: { id: path.id },
        data: { updatedById: userId },
      });
    });

    for (const level of dto.levels) {
      await this.grantRole(
        'unit_approver',
        level.userId,
        unitId,
        unit.name,
        userId,
      );
    }

    return this.findOne(unitId, raiserId, userId);
  }

  /**
   * Give someone the access their new job needs.
   *
   * A user with zero role assignments cannot sign in at all
   * (`auth.service.ts`), and a unit-scoped role is what makes that unit's
   * requisitions visible — so nominating a raiser or naming an approver
   * provisions the matching role automatically. Deliberately additive: nothing
   * is revoked when someone is removed, because they may still sit on in-flight
   * requisitions whose chains were snapshotted earlier.
   */
  private async grantRole(
    roleKey: 'requisition_raiser' | 'unit_approver',
    userId: string,
    unitId: string,
    unitName: string,
    grantedById: string,
  ): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { key: roleKey } });
    if (!role) {
      this.logger.warn(`${roleKey} role missing — access was not auto-granted`);
      return;
    }

    const already = await this.prisma.roleAssignment.findFirst({
      where: { roleId: role.id, userId, unitId },
    });
    if (already) return;

    // An approver who already reaches this unit some other way needs nothing;
    // a raiser always needs the raiser role specifically, since raising is
    // gated on it rather than on plain unit access.
    if (
      roleKey === 'unit_approver' &&
      (await this.permissions.canAccessUnitName(userId, unitName))
    ) {
      return;
    }

    await this.prisma.roleAssignment.create({
      data: { roleId: role.id, userId, unitId, assignedById: grantedById },
    });
    this.permissions.invalidate(userId);
    this.logger.log(`Granted ${roleKey} on ${unitName} to user ${userId}`);
  }

  /** Named approvers must be real, active users — and not the raiser. */
  private async validateLevels(
    levels: ReplaceApprovalPathDto['levels'],
    raiserId: string,
  ): Promise<void> {
    const ids = levels.map((l) => l.userId);

    if (ids.includes(raiserId)) {
      throw new BadRequestException(
        'The raiser cannot approve their own requisition',
      );
    }

    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (duplicates.length > 0) {
      throw new BadRequestException(
        'The same person cannot appear at more than one level',
      );
    }

    if (ids.length === 0) return;

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, status: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    if (ids.some((id) => !byId.has(id))) {
      throw new BadRequestException(
        'One or more selected people no longer exist',
      );
    }
    const inactive = users.filter((u) => u.status !== 'ACTIVE');
    if (inactive.length > 0) {
      throw new BadRequestException(
        `${inactive.map((u) => u.name).join(', ')} is not an active user`,
      );
    }
  }

  // --- consumed by the requisition workflow -------------------------------

  /**
   * Snapshot this raiser's chain into ApprovalStep create-payloads, with a
   * Corporate HR step always appended last.
   *
   * Configured levels are person-routed (a named approver). The Corporate HR
   * step is left role-routed on purpose — a unit can have several Corporate HR
   * holders, and any of them may sign, so naming one at raise time would be a
   * guess. Snapshotting the rest means editing a path never reroutes a
   * requisition already in flight.
   */
  async buildStepsForRaiser(
    unitName: string,
    raiserId: string,
  ): Promise<Prisma.ApprovalStepCreateWithoutRequisitionInput[]> {
    const units = await this.prisma.unit.findMany({
      select: { id: true, name: true },
    });
    // Match through normalizeUnitName — ZingHR and hand-configured unit names
    // drift on trailing punctuation (see CLAUDE.md §10).
    const unit = units.find((u) => sameUnit(u.name, unitName));
    if (!unit) {
      throw new BadRequestException(
        `No approval path is configured for you in "${unitName}" — ask Corporate HR to set one up.`,
      );
    }

    const path = await this.prisma.approvalPath.findUnique({
      where: { unitId_raiserId: { unitId: unit.id, raiserId } },
      include: {
        levels: {
          orderBy: { orderIndex: 'asc' },
          include: { user: { select: { id: true, name: true } } },
        },
      },
    });

    if (!path) {
      throw new BadRequestException(
        `No approval path is configured for you in "${unit.name}" — ask Corporate HR to set one up before raising a requisition here.`,
      );
    }

    const steps: Prisma.ApprovalStepCreateWithoutRequisitionInput[] =
      path.levels.map((level) => ({
        orderIndex: level.orderIndex,
        role: null,
        approverUserId: level.userId,
        title: level.title,
        subtitle: level.subtitle,
        assignee: level.user.name,
        status: 'PENDING' as const,
      }));

    const holders = await this.permissions.roleHolderNames(
      'corporate_hr',
      unit.name,
    );
    steps.push({
      orderIndex: steps.length,
      // Left role-routed (no named approver) so any Corporate HR holder for
      // the unit may sign — naming one at raise time would be a guess.
      role: 'CORPORATE_HR',
      title: CORPORATE_HR_STEP.title,
      subtitle: CORPORATE_HR_STEP.subtitle,
      assignee: holders.join(', '),
      status: 'PENDING',
    });

    return steps;
  }
}

function serializePath(
  unitId: string,
  unitName: string,
  path: PathWithLevels,
) {
  return {
    unitId,
    unitName,
    raiser: {
      id: path.raiser.id,
      name: path.raiser.name,
      employeeCode: path.raiser.employeeCode,
      designation: path.raiser.employee?.designation ?? null,
      department: path.raiser.employee?.department ?? null,
    },
    levels: path.levels.map((level) => ({
      id: level.id,
      orderIndex: level.orderIndex,
      userId: level.userId,
      title: level.title,
      subtitle: level.subtitle,
      approver: {
        id: level.user.id,
        name: level.user.name,
        employeeCode: level.user.employeeCode,
        designation: level.user.employee?.designation ?? null,
        department: level.user.employee?.department ?? null,
      },
    })),
    updatedAt: path.updatedAt?.toISOString() ?? null,
  };
}
