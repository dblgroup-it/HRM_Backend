import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalDecision,
  ComputerRequirement,
  EmploymentNature,
  Prisma,
  Priority,
  RequisitionSource,
  SeatingArrangement,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OrganogramService } from '../organogram/organogram.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { buildMeta, Paginated } from '../../common/dto/pagination.dto';
import { CreateRequisitionDto } from './dto/create-requisition.dto';
import {
  ApprovalActionDto,
  PostRequisitionDto,
  QueryRequisitionsDto,
  UpdateRequisitionDto,
} from './dto/requisition-actions.dto';
import { buildChainSteps, synthesizeRoleProfile } from './requisition.workflow';

const reqWithRelations = {
  approvalSteps: { orderBy: { orderIndex: 'asc' } },
  activities: { orderBy: { at: 'asc' } },
} satisfies Prisma.RequisitionInclude;

type RequisitionFull = Prisma.RequisitionGetPayload<{
  include: typeof reqWithRelations;
}>;

@Injectable()
export class RequisitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organogram: OrganogramService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    dto: CreateRequisitionDto,
    raiser: { id: string; name: string },
  ) {
    await this.ensureUnitAccess(raiser.id, dto.unitFactory);

    // Authoritative New vs Replacement decision from the organogram.
    const lookup = await this.organogram.lookup(
      dto.unitFactory,
      dto.department,
      dto.designation,
      raiser.id,
    );
    const requirementType =
      lookup.requirement === 'existing' ? 'EXISTING' : 'NEW';
    const source = dto.source.toUpperCase() as RequisitionSource;

    const steps = buildChainSteps(requirementType, source, {
      departmentHeadName: dto.signatories.departmentHeadName,
      factoryHRName: dto.signatories.factoryHRName,
    });

    // Auto-assign each step to the configured role-holder(s) for this unit.
    for (const step of steps) {
      const holders = await this.permissions.roleHolderNames(
        step.role.toLowerCase(),
        dto.unitFactory,
      );
      if (holders.length > 0) step.assignee = holders.join(', ');
    }

    // The raiser IS the Department Head — their own step is signed on submit,
    // so the chain starts at the next approver (Factory HR / Corporate HR).
    const raisedBy = dto.signatories.departmentHeadName || raiser.name;
    const deptHeadStep = steps.find((s) => s.role === 'DEPARTMENT_HEAD');
    if (deptHeadStep) {
      deptHeadStep.status = 'APPROVED';
      deptHeadStep.assignee = raisedBy;
      deptHeadStep.actedAt = new Date();
    }

    const created = await this.prisma.requisition.create({
      data: {
        code: await this.nextCode(),
        designation: dto.designation,
        requirementType,
        source,
        requiredPosts: dto.requiredPosts,
        totalVacantPosts: dto.totalVacantPosts,
        unitFactory: dto.unitFactory,
        department: dto.department,
        placeOfPosting: dto.placeOfPosting,
        vacantDate: toDate(dto.vacantDate),
        whenNeededDate: toDate(dto.whenNeededDate),
        priority: dto.priority.toUpperCase() as Priority,
        employmentNature:
          dto.employmentNature.toUpperCase() as EmploymentNature,
        contractualPurpose: dto.contractualPurpose ?? null,
        jobDescription: dto.jobDescription,
        education: dto.education,
        experience: dto.experience,
        others: dto.others ?? null,
        computer: dto.computer.toUpperCase() as ComputerRequirement,
        computerReason: dto.computerReason ?? null,
        seating: dto.seating.toUpperCase() as SeatingArrangement,
        preferredSources: dto.preferredSources ?? [],
        status: 'PENDING_APPROVAL',
        raisedBy,
        raisedById: raiser.id,
        approvalSteps: { create: steps },
        activities: {
          create: [
            {
              actor: raisedBy,
              action: 'APPROVED',
              note: 'Raised & signed by Department Head',
            },
          ],
        },
      },
      include: reqWithRelations,
    });

    const serialized = serialize(created);
    this.notifications.broadcastChange('requisition', created.id, {
      action: 'created',
      record: serialized,
    });
    await this.notifyPendingApprover(created);

    return serialized;
  }

  /** Notify whoever currently needs to act on a requisition. */
  private async notifyPendingApprover(req: RequisitionFull): Promise<void> {
    const pending = req.approvalSteps.find((s) => s.status === 'PENDING');
    if (!pending) return;
    const userIds = await this.permissions.roleHolderUserIds(
      pending.role.toLowerCase(),
      req.unitFactory,
    );
    await this.notifications.notifyMany(userIds, {
      type: 'requisition_pending',
      title: `${pending.title} approval needed`,
      message: `${req.code} · ${req.designation} (${req.unitFactory}) awaits your approval.`,
      link: `/requisitions/${req.id}`,
    });
  }

  async findAll(
    query: QueryRequisitionsDto,
    userId: string,
  ): Promise<Paginated<unknown>> {
    const { page, pageSize, search, status, unitFactory } = query;
    const scope = await this.permissions.getUnitAccessScope(userId);

    const visibleUnitFilter = scope.all
      ? unitFactory && unitFactory !== 'all'
        ? { equals: unitFactory, mode: 'insensitive' as const }
        : undefined
      : this.buildVisibleUnitFilter(scope.unitNames, unitFactory);

    if (!scope.all && visibleUnitFilter === null) {
      return {
        items: [],
        meta: buildMeta(page, pageSize, 0),
      };
    }

    const where: Prisma.RequisitionWhereInput = {
      ...(status && status !== 'all'
        ? { status: status.toUpperCase() as Prisma.EnumRequisitionStatusFilter }
        : {}),
      ...(visibleUnitFilter && visibleUnitFilter !== undefined
        ? { unitFactory: visibleUnitFilter }
        : {}),
      ...(search
        ? {
            OR: [
              { designation: { contains: search, mode: 'insensitive' } },
              { code: { contains: search, mode: 'insensitive' } },
              { department: { contains: search, mode: 'insensitive' } },
              { unitFactory: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.requisition.findMany({
        where,
        include: reqWithRelations,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.requisition.count({ where }),
    ]);

    return {
      items: rows.map(serialize),
      meta: buildMeta(page, pageSize, total),
    };
  }

  async findOne(id: string, userId: string) {
    const req = await this.load(id, userId);
    return serialize(req);
  }

  /** Step 2 — act on the active (first pending) sign-off. */
  async act(
    id: string,
    dto: ApprovalActionDto,
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    const note = dto.note ?? '';
    const steps = req.approvalSteps;
    const idx = steps.findIndex((s) => s.status === 'PENDING');
    if (idx === -1) {
      throw new BadRequestException('No pending sign-off to act on');
    }

    const current = steps[idx];

    // Enforce: only a holder of this step's role for this unit (or a super
    // user) may act.
    const allowed = await this.permissions.hasRoleForUnitName(
      actor.id,
      current.role.toLowerCase(),
      req.unitFactory,
    );
    if (!allowed) {
      throw new ForbiddenException(
        `You don't hold the "${current.title}" role for ${req.unitFactory}`,
      );
    }

    // Escalation is only valid from the Corporate HR step.
    if (dto.decision === 'escalate' && current.role !== 'CORPORATE_HR') {
      throw new BadRequestException('Only Corporate HR can escalate to CHRO');
    }

    const actorName = actor.name;
    const action: ApprovalDecision =
      dto.decision === 'escalate'
        ? 'ESCALATED'
        : (dto.decision.toUpperCase() as ApprovalDecision);

    // Resolve CHRO holder(s) up front for the escalate path.
    const chroAssignee =
      dto.decision === 'escalate'
        ? (
            await this.permissions.roleHolderNames('chro', req.unitFactory)
          ).join(', ')
        : '';

    await this.prisma.$transaction(async (tx) => {
      await tx.requisitionActivity.create({
        data: { requisitionId: id, actor: actorName, action, note },
      });

      if (dto.decision === 'escalate') {
        // Corporate HR signs off, then a CHRO step is appended for final approval.
        await tx.approvalStep.update({
          where: { id: current.id },
          data: {
            status: 'APPROVED',
            assignee: actorName,
            note,
            actedAt: new Date(),
          },
        });
        await tx.approvalStep.create({
          data: {
            requisitionId: id,
            orderIndex: steps.length,
            role: 'CHRO',
            title: 'CHRO',
            subtitle: 'Escalated final approval',
            assignee: chroAssignee,
            status: 'PENDING',
          },
        });
        return;
      }

      if (dto.decision === 'rejected') {
        await tx.approvalStep.update({
          where: { id: current.id },
          data: { status: 'REJECTED', note, actedAt: new Date() },
        });
        await tx.requisition.update({
          where: { id },
          data: { status: 'REJECTED' },
        });
        return;
      }

      if (dto.decision === 'need_more_info') {
        // Roll back to the previous approver, if any.
        if (idx > 0) {
          await tx.approvalStep.update({
            where: { id: steps[idx - 1].id },
            data: { status: 'PENDING', note, actedAt: null },
          });
        }
        return;
      }

      // approved
      await tx.approvalStep.update({
        where: { id: current.id },
        data: {
          status: 'APPROVED',
          assignee: actorName,
          note,
          actedAt: new Date(),
        },
      });
      const isLast = idx === steps.length - 1;
      if (isLast) {
        await tx.requisition.update({
          where: { id },
          data: { status: 'APPROVED' },
        });
      }
    });

    const updated = await this.notifyAfterAction(id, dto.decision, actorName);
    return serialize(updated);
  }

  /** Live updates + targeted notifications after a sign-off action. */
  private async notifyAfterAction(
    id: string,
    decision: ApprovalActionDto['decision'],
    actorName: string,
  ): Promise<RequisitionFull> {
    const req = await this.load(id);
    this.notifications.broadcastChange('requisition', id, {
      action: decision,
      record: serialize(req),
    });

    if (req.status === 'APPROVED') {
      if (req.raisedById) {
        await this.notifications.notify(req.raisedById, {
          type: 'requisition_approved',
          title: 'Requisition fully approved',
          message: `${req.code} · ${req.designation} is approved — Corporate HR will continue.`,
          link: `/requisitions/${id}`,
        });
      }
      return req;
    }

    if (req.status === 'REJECTED') {
      if (req.raisedById) {
        await this.notifications.notify(req.raisedById, {
          type: 'requisition_rejected',
          title: 'Requisition rejected',
          message: `${req.code} · ${req.designation} was rejected by ${actorName}.`,
          link: `/requisitions/${id}`,
        });
      }
      return req;
    }

    // Still in flight — ping whoever is now pending (next approver, the previous
    // role after "need more info", or CHRO after an escalation).
    if (decision === 'need_more_info' && req.raisedById) {
      await this.notifications.notify(req.raisedById, {
        type: 'requisition_info',
        title: 'More info requested',
        message: `${req.code} was sent back for clarification by ${actorName}.`,
        link: `/requisitions/${id}`,
      });
    }
    await this.notifyPendingApprover(req);
    return req;
  }

  /**
   * Edit a requisition's details. Allowed only while it's awaiting approval and
   * only by the current pending approver (e.g. the Department Head after it was
   * bounced back with "need more info"), or a super user.
   */
  async update(
    id: string,
    dto: UpdateRequisitionDto,
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    if (req.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Only requisitions awaiting approval can be edited',
      );
    }
    const current = req.approvalSteps.find((s) => s.status === 'PENDING');
    if (!current) throw new BadRequestException('No pending step to edit on');

    const allowed = await this.permissions.hasRoleForUnitName(
      actor.id,
      current.role.toLowerCase(),
      req.unitFactory,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Only the current approver can edit this requisition',
      );
    }

    const updated = await this.prisma.requisition.update({
      where: { id },
      data: {
        ...(dto.requiredPosts !== undefined
          ? { requiredPosts: dto.requiredPosts }
          : {}),
        ...(dto.totalVacantPosts !== undefined
          ? { totalVacantPosts: dto.totalVacantPosts }
          : {}),
        ...(dto.placeOfPosting !== undefined
          ? { placeOfPosting: dto.placeOfPosting }
          : {}),
        ...(dto.vacantDate !== undefined
          ? { vacantDate: toDate(dto.vacantDate) }
          : {}),
        ...(dto.whenNeededDate !== undefined
          ? { whenNeededDate: toDate(dto.whenNeededDate) }
          : {}),
        ...(dto.priority
          ? { priority: dto.priority.toUpperCase() as Priority }
          : {}),
        ...(dto.employmentNature
          ? {
              employmentNature:
                dto.employmentNature.toUpperCase() as EmploymentNature,
            }
          : {}),
        ...(dto.contractualPurpose !== undefined
          ? { contractualPurpose: dto.contractualPurpose }
          : {}),
        ...(dto.jobDescription !== undefined
          ? { jobDescription: dto.jobDescription }
          : {}),
        ...(dto.education !== undefined ? { education: dto.education } : {}),
        ...(dto.experience !== undefined ? { experience: dto.experience } : {}),
        ...(dto.others !== undefined ? { others: dto.others } : {}),
        ...(dto.preferredSources !== undefined
          ? { preferredSources: dto.preferredSources }
          : {}),
      },
      include: reqWithRelations,
    });
    const serialized = serialize(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'updated',
      record: serialized,
    });
    return serialized;
  }

  /** Step 3 — generate the AI role profile. Corporate HR owns this step. */
  async generateRoleProfile(id: string, actor: { id: string; name: string }) {
    const req = await this.load(id, actor.id);
    if (req.status !== 'APPROVED' && req.status !== 'PROFILE_GENERATED') {
      throw new BadRequestException(
        'Role profile can only be generated after full approval',
      );
    }
    await this.ensureCorporateHrContinuation(req, actor.id);
    const roleProfile = synthesizeRoleProfile(req);
    const updated = await this.prisma.requisition.update({
      where: { id },
      data: {
        roleProfile: roleProfile as unknown as Prisma.InputJsonValue,
        status: 'PROFILE_GENERATED',
      },
      include: reqWithRelations,
    });
    const serialized = serialize(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'role_profile_generated',
      record: serialized,
    });
    if (req.raisedById) {
      await this.notifications.notify(req.raisedById, {
        type: 'requisition_profile',
        title: 'Role profile generated',
        message: `${req.code} · ${req.designation} — the AI role profile is ready.`,
        link: `/requisitions/${id}`,
      });
    }
    return serialized;
  }

  /** Step 4 — publish to candidate sources. Corporate HR owns this step. */
  async post(
    id: string,
    dto: PostRequisitionDto,
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    if (req.status !== 'PROFILE_GENERATED' && req.status !== 'POSTED') {
      throw new BadRequestException('Generate the role profile before posting');
    }
    await this.ensureCorporateHrContinuation(req, actor.id);
    const posting = {
      sources: dto.sources,
      closingDate: dto.closingDate,
      postedAt: new Date().toISOString(),
    };
    const updated = await this.prisma.requisition.update({
      where: { id },
      data: {
        posting: posting as unknown as Prisma.InputJsonValue,
        status: 'POSTED',
      },
      include: reqWithRelations,
    });
    const serialized = serialize(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'posted',
      record: serialized,
    });
    if (req.raisedById) {
      await this.notifications.notify(req.raisedById, {
        type: 'requisition_posted',
        title: 'Requisition posted',
        message: `${req.code} · ${req.designation} is now published to candidate sources.`,
        link: `/requisitions/${id}`,
      });
    }
    return serialized;
  }

  // --- internals ----------------------------------------------------------

  private async load(id: string, userId?: string): Promise<RequisitionFull> {
    const req = await this.prisma.requisition.findUnique({
      where: { id },
      include: reqWithRelations,
    });
    if (!req) throw new NotFoundException('Requisition not found');
    if (userId) await this.ensureUnitAccess(userId, req.unitFactory);
    return req;
  }

  private async ensureUnitAccess(
    userId: string,
    unitName: string,
  ): Promise<void> {
    const allowed = await this.permissions.canAccessUnitName(userId, unitName);
    if (!allowed) {
      throw new ForbiddenException('You can only access your assigned units');
    }
  }

  private buildVisibleUnitFilter(
    unitNames: string[],
    unitFactory?: string,
  ): Prisma.RequisitionWhereInput['unitFactory'] | null {
    if (unitFactory && unitFactory !== 'all') {
      const allowed = unitNames.some(
        (name) => name.toLowerCase() === unitFactory.toLowerCase(),
      );
      return allowed
        ? { equals: unitFactory, mode: 'insensitive' }
        : null;
    }

    if (unitNames.length === 0) return null;
    return { in: unitNames };
  }

  private async ensureCorporateHrContinuation(
    req: RequisitionFull,
    userId: string,
  ): Promise<void> {
    const allowed = await this.permissions.hasRoleForUnitName(
      userId,
      'corporate_hr',
      req.unitFactory,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR can continue after approval',
      );
    }
  }

  private async nextCode(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.prisma.requisition.count();
    return `REQ-${year}-${String(count + 1).padStart(3, '0')}`;
  }
}

// --- serialization (DB enums → frontend lowercase shape) -------------------

function low(value: string): string {
  return value.toLowerCase();
}

function serialize(req: RequisitionFull) {
  return {
    id: req.id,
    code: req.code,
    designation: req.designation,
    requirementType: low(req.requirementType),
    source: low(req.source),
    requiredPosts: req.requiredPosts,
    totalVacantPosts: req.totalVacantPosts,
    unitFactory: req.unitFactory,
    department: req.department,
    placeOfPosting: req.placeOfPosting,
    vacantDate: req.vacantDate?.toISOString() ?? null,
    whenNeededDate: req.whenNeededDate?.toISOString() ?? null,
    priority: low(req.priority),
    employmentNature: low(req.employmentNature),
    contractualPurpose: req.contractualPurpose ?? '',
    jobDescription: req.jobDescription,
    education: req.education,
    experience: req.experience,
    others: req.others ?? '',
    computer: low(req.computer),
    computerReason: req.computerReason ?? '',
    seating: low(req.seating),
    preferredSources: req.preferredSources,
    status: low(req.status),
    approvalChain: req.approvalSteps.map((s) => ({
      role: low(s.role),
      title: s.title,
      subtitle: s.subtitle,
      assignee: s.assignee,
      status: low(s.status),
      note: s.note,
      actedAt: s.actedAt?.toISOString() ?? null,
    })),
    activityLog: req.activities.map((a) => ({
      actor: a.actor,
      action: low(a.action),
      note: a.note,
      at: a.at.toISOString(),
    })),
    roleProfile: req.roleProfile ?? null,
    posting: req.posting ?? null,
    raisedBy: req.raisedBy ?? '',
    createdAt: req.createdAt.toISOString(),
    updatedAt: req.updatedAt.toISOString(),
  };
}

function toDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
