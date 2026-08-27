import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApprovalDecision,
  EmploymentNature,
  Prisma,
  Priority,
  RequisitionSource,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { sameUnit } from '../../common/util/normalize-unit';
import { OrganogramService } from '../organogram/organogram.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { RecruitmentService } from '../candidates/recruitment.service';
import { CandidatesService } from '../candidates/candidates.service';
import { DriveService } from '../integrations/google/drive.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import { SettingsService } from '../settings/settings.service';
import { buildMeta, Paginated } from '../../common/dto/pagination.dto';
import {
  CreateRequisitionDto,
  FacilitiesRequestDto,
} from './dto/create-requisition.dto';
import {
  ApprovalActionDto,
  PostRequisitionDto,
  QueryRequisitionsDto,
  UpdateFacilitiesDto,
  UpdateRequisitionDto,
} from './dto/requisition-actions.dto';
import { buildChainSteps, synthesizeRoleProfile } from './requisition.workflow';

const reqWithRelations = {
  approvalSteps: { orderBy: { orderIndex: 'asc' } },
  activities: { orderBy: { createdAt: 'asc' } },
  candidates: {
    select: { stage: true, onboarding: { select: { status: true } } },
  },
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
    private readonly recruitment: RecruitmentService,
    private readonly candidates: CandidatesService,
    private readonly drive: DriveService,
    private readonly ai: AiGraderService,
    private readonly settings: SettingsService,
  ) {}

  private readonly logger = new Logger(RequisitionService.name);

  async create(
    dto: CreateRequisitionDto,
    raiser: { id: string; name: string },
  ) {
    await this.ensureUnitAccess(raiser.id, dto.unitFactory);

    // Authoritative New vs Replacement decision from the organogram.
    // NEW (needs SBU for factory) when the requested posts exceed the vacant
    // sanctioned seats — i.e. you're asking for headcount beyond what's vacant.
    // Replacement only when required ≤ vacant.
    const lookup = await this.organogram.lookup(
      dto.unitFactory,
      dto.department,
      dto.designation,
      raiser.id,
    );
    const requirementType =
      dto.requiredPosts > lookup.vacant ? 'NEW' : 'EXISTING';
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
        section: dto.section ?? null,
        placeOfPosting: dto.placeOfPosting,
        vacantDate: toDate(dto.vacantDate),
        neededDate: toDate(dto.neededDate),
        priority: dto.priority.toUpperCase() as Priority,
        employmentNature:
          dto.employmentNature.toUpperCase() as EmploymentNature,
        contractualPurpose: dto.contractualPurpose ?? null,
        jobDescription: dto.jobDescription,
        education: dto.education,
        experience: dto.experience,
        others: dto.others ?? null,
        facilities: buildInitialFacilities(
          dto.facilities,
        ) as unknown as Prisma.InputJsonValue,
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
      deletedAt: null,
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

  /**
   * AI quick-fill: turn a one-line request into a drafted requisition. The AI
   * is grounded on the units this user may actually raise for and their real
   * departments, so it cannot invent an organisational unit. Nothing is saved —
   * the draft is returned for the human to review, edit and submit.
   */
  async draft(prompt: string, userId: string) {
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const clean = prompt.trim();
    if (clean.length < 5) {
      throw new BadRequestException('Describe the vacancy in a few more words');
    }

    // The units this requester is allowed to raise for (same rule as the form).
    const scope = await this.permissions.getUnitAccessScope(userId);
    const allUnits = await this.prisma.unit.findMany({
      where: { isActive: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    const units = scope.all
      ? allUnits.map((u) => u.name)
      : allUnits
          .map((u) => u.name)
          .filter((name) =>
            scope.unitNames.some((allowed) => sameUnit(allowed, name)),
          );
    if (!units.length) {
      throw new ForbiddenException(
        'You are not assigned to any unit, so you cannot raise a requisition',
      );
    }

    // Real departments + designations per unit, so the AI copies rather than invents.
    const structure = await Promise.all(
      units.map(async (unit) => {
        const tree = await this.employeeStructure(unit);
        return { unit, departments: tree };
      }),
    );

    const result = await this.ai.draftRequisition({
      prompt: clean,
      units,
      structure,
      today: new Date().toISOString().slice(0, 10),
    });
    return result;
  }

  /** Department → designations for one unit (from synced employees + organogram). */
  private async employeeStructure(unit: string) {
    const [rows, orgUnits] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          unitName: { equals: unit, mode: 'insensitive' },
          department: { not: null },
        },
        select: { department: true, designation: true },
        take: 4000,
      }),
      this.prisma.unit.findMany({
        where: { name: { equals: unit, mode: 'insensitive' } },
        select: {
          departments: {
            select: {
              name: true,
              positions: { select: { designation: true } },
            },
          },
        },
      }),
    ]);

    const map = new Map<string, Set<string>>();
    const add = (dept: string, designation: string) => {
      const d = dept.trim();
      if (!d) return;
      const set = map.get(d) ?? new Set<string>();
      map.set(d, set);
      if (designation.trim()) set.add(designation.trim());
    };
    for (const r of rows) add(r.department ?? '', r.designation ?? '');
    for (const u of orgUnits) {
      for (const d of u.departments) {
        for (const p of d.positions) add(d.name, p.designation);
        add(d.name, '');
      }
    }
    return [...map.entries()]
      .map(([department, designations]) => ({
        department,
        designations: [...designations].slice(0, 15),
      }))
      .sort((a, b) => a.department.localeCompare(b.department));
  }

  /**
   * Counts per status for the tiles/chips — computed in the database so the
   * page never has to pull every requisition just to count them.
   */
  async stats(query: QueryRequisitionsDto, userId: string) {
    const { search, unitFactory } = query;
    const scope = await this.permissions.getUnitAccessScope(userId);
    const visibleUnitFilter = scope.all
      ? unitFactory && unitFactory !== 'all'
        ? { equals: unitFactory, mode: 'insensitive' as const }
        : undefined
      : this.buildVisibleUnitFilter(scope.unitNames, unitFactory);

    if (!scope.all && visibleUnitFilter === null) {
      return { total: 0, byStatus: {} };
    }

    const where: Prisma.RequisitionWhereInput = {
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

    const groups = await this.prisma.requisition.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      byStatus[g.status.toLowerCase()] = g._count._all;
      total += g._count._all;
    }
    return { total, byStatus };
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

    if (updated.status === 'APPROVED') {
      this.candidates.syncTalentBankMatchesOnRequisitionEvent(id);
    }

    // Optionally auto-generate the role profile the moment it's fully approved.
    if (updated.status === 'APPROVED' && this.ai.isConfigured()) {
      const cfg = await this.settings.getAiConfig();
      if (cfg.autoRoleProfile) {
        try {
          const profile = await this.buildRoleProfile(updated);
          const regenerated = await this.prisma.requisition.update({
            where: { id },
            data: {
              roleProfile: profile as unknown as Prisma.InputJsonValue,
              status: 'PROFILE_GENERATED',
            },
            include: reqWithRelations,
          });
          this.notifications.broadcastChange('requisition', id, {
            action: 'role_profile_generated',
            record: serialize(regenerated),
          });
          return serialize(regenerated);
        } catch (err) {
          this.logger.warn(
            `Auto role-profile failed: ${(err as Error).message}`,
          );
        }
      }
    }
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
    await this.requireCurrentApprover(req, actor.id);

    const nextGrade = dto.grade !== undefined ? dto.grade.trim() || null : undefined;
    const gradeChanged = nextGrade !== undefined && nextGrade !== req.grade;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (gradeChanged) {
        await tx.requisitionActivity.create({
          data: {
            requisitionId: id,
            actor: actor.name,
            action: 'EDITED',
            note: req.grade
              ? `Job Grade changed from ${req.grade} to ${nextGrade ?? '—'}`
              : `Job Grade set to ${nextGrade ?? '—'}`,
          },
        });
      }

      return tx.requisition.update({
        where: { id },
        data: {
          ...(nextGrade !== undefined ? { grade: nextGrade } : {}),
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
          ...(dto.neededDate !== undefined
            ? { neededDate: toDate(dto.neededDate) }
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
    });
    const serialized = serialize(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'updated',
      record: serialized,
    });
    return serialized;
  }

  /**
   * HR confirms or skips one or more of the requisitioner's facility requests
   * (Laptop/Desktop, Transport, Dormitory, Seating). While the requisition is
   * awaiting approval, only the current pending approver (Factory HR, SBU
   * Head, Corporate HR — whoever's turn it is) or a super user may act, same
   * as `update()`. Once approved, there's no more pending step — so from that
   * point on Corporate HR / CHRO / super users may keep re-confirming or
   * changing a decision (e.g. from the Onboarding page, right up to joining).
   */
  async updateFacilities(
    id: string,
    dto: UpdateFacilitiesDto,
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    await this.requireFacilitiesEditAccess(req, actor.id);

    const current = (req.facilities ?? {}) as unknown as Record<string, FacilityDecision>;
    const next: Record<string, FacilityDecision> = { ...current };
    const changes: { key: string; note: string }[] = [];
    for (const d of dto.decisions) {
      // Requisitions created before the `facilities` column existed have no
      // seeded entry for this key — fall back to an empty pending decision
      // instead of silently skipping (see updateFacilities pre-migration bug).
      const existing: FacilityDecision =
        next[d.key] ??
        ({
          requested: false,
          option: null,
          note: '',
          status: 'pending',
          hrNote: '',
          decidedBy: null,
          decidedAt: null,
        } satisfies FacilityDecision);
      if (existing.status === d.status && (existing.hrNote ?? '') === (d.hrNote ?? '')) {
        continue; // no-op — don't log or touch decidedBy/decidedAt for an unchanged decision
      }
      const verb = d.status === 'confirmed' ? 'Confirmed' : 'Skipped';
      const label = FACILITY_LABEL[d.key] ?? d.key;
      changes.push({
        key: d.key,
        note:
          existing.status === 'pending'
            ? `${verb} ${label}${d.hrNote ? ` — "${d.hrNote}"` : ''}`
            : `Changed ${label} from ${existing.status} to ${d.status}${d.hrNote ? ` — "${d.hrNote}"` : ''}`,
      });
      next[d.key] = {
        ...existing,
        status: d.status,
        hrNote: d.hrNote ?? existing.hrNote ?? '',
        decidedBy: actor.name,
        decidedAt: new Date().toISOString(),
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const c of changes) {
        await tx.requisitionActivity.create({
          data: { requisitionId: id, actor: actor.name, action: 'EDITED', note: c.note },
        });
      }
      return tx.requisition.update({
        where: { id },
        data: { facilities: next as unknown as Prisma.InputJsonValue },
        include: reqWithRelations,
      });
    });
    const serialized = serialize(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'updated',
      record: serialized,
    });
    return serialized;
  }

  /** Requisitions can only be edited/have facilities decided by whoever's turn it currently is. */
  private async requireCurrentApprover(
    req: RequisitionFull,
    actorId: string,
  ): Promise<void> {
    if (req.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Only requisitions awaiting approval can be edited',
      );
    }
    const current = req.approvalSteps.find((s) => s.status === 'PENDING');
    if (!current) throw new BadRequestException('No pending step to edit on');

    const allowed = await this.permissions.hasRoleForUnitName(
      actorId,
      current.role.toLowerCase(),
      req.unitFactory,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Only the current approver can edit this requisition',
      );
    }
  }

  /** Facilities stay editable after approval (Corporate HR/CHRO/super), unlike the rest of the requisition's content. */
  private async requireFacilitiesEditAccess(
    req: RequisitionFull,
    actorId: string,
  ): Promise<void> {
    if (req.status === 'PENDING_APPROVAL') {
      await this.requireCurrentApprover(req, actorId);
      return;
    }
    const allowed =
      (await this.permissions.hasRoleForUnitName(actorId, 'corporate_hr', req.unitFactory)) ||
      (await this.permissions.hasRoleForUnitName(actorId, 'chro', req.unitFactory));
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can change facility decisions after approval',
      );
    }
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
    const roleProfile = await this.buildRoleProfile(req);
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

  /** Save Corporate HR's manual edits to the role profile. */
  async updateRoleProfile(
    id: string,
    dto: {
      summary: string;
      jobDescription: string;
      responsibilities: string[];
      requirements: string[];
    },
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    if (req.status !== 'APPROVED' && req.status !== 'PROFILE_GENERATED') {
      throw new BadRequestException(
        'Role profile can only be edited after full approval',
      );
    }
    await this.ensureCorporateHrContinuation(req, actor.id);

    const clean = (lines: string[]) =>
      lines.map((l) => l.trim()).filter(Boolean);
    const roleProfile = {
      summary: dto.summary.trim(),
      jobDescription: dto.jobDescription.trim(),
      responsibilities: clean(dto.responsibilities),
      requirements: clean(dto.requirements),
      generatedAt: new Date().toISOString(),
      generatedBy: 'manual' as const,
    };

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
      action: 'role_profile_updated',
      record: serialized,
    });
    return serialized;
  }

  /**
   * Build the role profile: ask the configured LLM (Gemini/Claude) to write it
   * from the requisition's details, falling back to a deterministic template
   * field-by-field if AI is off or returns nothing.
   */
  private async buildRoleProfile(req: {
    designation: string;
    department: string;
    unitFactory: string;
    placeOfPosting: string;
    jobDescription: string;
    education: string;
    experience: string;
    others: string | null;
    requiredPosts: number;
    employmentNature: EmploymentNature;
  }) {
    const base = synthesizeRoleProfile(req);
    if (!this.ai.isConfigured()) {
      return { ...base, generatedBy: 'template' as const };
    }
    try {
      const ai = await this.ai.generateRoleProfile({
        designation: req.designation,
        department: req.department,
        unitFactory: req.unitFactory,
        placeOfPosting: req.placeOfPosting,
        jobDescription: req.jobDescription,
        education: req.education,
        experience: req.experience,
        others: req.others,
        requiredPosts: req.requiredPosts,
        employmentNature: String(req.employmentNature).toLowerCase(),
      });
      return {
        summary: ai.summary || base.summary,
        jobDescription: ai.jobDescription || base.jobDescription,
        responsibilities: ai.responsibilities.length
          ? ai.responsibilities
          : base.responsibilities,
        requirements: ai.requirements.length
          ? ai.requirements
          : base.requirements,
        generatedAt: new Date().toISOString(),
        generatedBy: 'ai' as const,
      };
    } catch (e) {
      this.logger.warn(
        `AI role profile failed, using template: ${(e as Error).message}`,
      );
      return { ...base, generatedBy: 'template' as const };
    }
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

    // Return immediately so the HTTP response isn't blocked by Drive API calls.
    // Drive workspace creation runs in the background; when it finishes we push
    // a requisition:changed broadcast so the frontend refreshes automatically.
    this.setupDriveWorkspace(updated, req.raisedById ?? null).catch((err) =>
      this.logger.warn(
        `Drive workspace setup failed for ${updated.code}: ${(err as Error).message}`,
      ),
    );
    this.candidates.syncTalentBankMatchesOnRequisitionEvent(id);

    return serialize(updated);
  }

  private async setupDriveWorkspace(
    updated: Awaited<ReturnType<typeof this.load>>,
    raisedById: string | null,
  ): Promise<void> {
    try {
      const drive = await this.recruitment.ensureWorkspace(updated);
      if (drive) {
        await this.prisma.requisition.update({
          where: { id: updated.id },
          data: { drive: drive as unknown as Prisma.InputJsonValue },
        });
      }
      // Re-fetch with the latest drive info and broadcast to all connected clients.
      const fresh = await this.prisma.requisition.findUnique({
        where: { id: updated.id },
        include: reqWithRelations,
      });
      if (!fresh) return;
      const serialized = serialize(fresh);
      this.notifications.broadcastChange('requisition', updated.id, {
        action: 'posted',
        record: serialized,
      });
      if (raisedById) {
        await this.notifications.notify(raisedById, {
          type: 'requisition_posted',
          title: 'Requisition posted',
          message: `${updated.code} · ${updated.designation} is now published to candidate sources.`,
          link: `/requisitions/${updated.id}`,
        });
      }
    } catch (err) {
      // Without this, a failure here left `requisition.drive` null forever —
      // the frontend's "working" spinner (RequisitionDetailPage.drivePhase)
      // has nothing else to watch and would spin indefinitely. Tell any open
      // clients so they can show an error + retry instead. The caller's own
      // .catch() still does the actual warning log — unchanged.
      this.notifications.broadcastRaw('requisition:drive_failed', {
        id: updated.id,
        message: 'Could not set up the Google Drive workspace automatically.',
      });
      throw err;
    }
  }

  // --- attachments ---------------------------------------------------------

  /** Upload a supporting file into the requisition's Drive "Attachments" folder. */
  async addAttachment(
    id: string,
    file:
      | { originalname: string; mimetype: string; buffer: Buffer; size: number }
      | undefined,
    actor: { id: string; name: string },
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const req = await this.load(id, actor.id);
    const ws = await this.recruitment.ensureWorkspace(req);
    if (!ws) {
      throw new BadRequestException(
        'Google Drive is not connected, so attachments can’t be stored',
      );
    }
    const folder = await this.drive.ensureFolder(
      '00 Requisition Attachments',
      ws.rootFolderId,
    );
    const uploaded = await this.drive.uploadFile(folder, {
      name: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    // Same as candidate CVs — the folder itself stays private, so each file
    // needs its own "anyone with the link" grant to be viewable without
    // being signed in as the recruitment account.
    this.drive
      .shareAnyoneWithLink(uploaded.id, 'reader')
      .catch((err) =>
        this.logger.warn(
          `Attachment share failed for ${uploaded.id}: ${(err as Error).message}`,
        ),
      );
    const attachments = [
      ...readAttachments(req),
      {
        name: file.originalname,
        fileId: uploaded.id,
        url: uploaded.url,
        size: file.size,
        uploadedBy: actor.name,
        uploadedAt: new Date().toISOString(),
      },
    ];
    const updated = await this.prisma.requisition.update({
      where: { id },
      data: { attachments: attachments as unknown as Prisma.InputJsonValue },
      include: reqWithRelations,
    });
    const serialized = serialize(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'attachment_added',
      record: serialized,
    });
    return serialized;
  }

  async removeAttachment(
    id: string,
    fileId: string,
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    const list = readAttachments(req);
    if (!list.some((a) => a.fileId === fileId)) {
      throw new NotFoundException('Attachment not found');
    }
    try {
      await this.drive.discardFile(fileId);
    } catch {
      // best-effort — still remove the reference
    }
    const next = list.filter((a) => a.fileId !== fileId);
    const updated = await this.prisma.requisition.update({
      where: { id },
      data: { attachments: next as unknown as Prisma.InputJsonValue },
      include: reqWithRelations,
    });
    const serialized = serialize(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'attachment_removed',
      record: serialized,
    });
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
      return allowed ? { equals: unitFactory, mode: 'insensitive' } : null;
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

/** Per-stage candidate counts for a requisition (Phase 2 pipeline). */
/**
 * Furthest pipeline progress across all candidates — drives the lifecycle
 * stepper beyond "Posted" (Candidates → Assessment → Onboarding → Done).
 */
function pipelineProgress(
  rows: { stage: string; onboarding: { status: string } | null }[],
) {
  const stages = rows.map((r) => r.stage.toLowerCase());
  const hasCandidates = rows.length > 0;
  const inAssessment = stages.some((s) => s === 'interview' || s === 'final');
  const inOnboarding = stages.some((s) => s === 'selected');
  const onboarded = rows.some((r) => r.onboarding?.status === 'onboarded');
  return { hasCandidates, inAssessment, inOnboarding, onboarded };
}

function candidateStats(rows: { stage: string }[]) {
  const s = {
    applied: 0,
    ai_shortlisted: 0,
    shortlisted: 0,
    interview: 0,
    final: 0,
    selected: 0,
    rejected: 0,
    total: rows.length,
  };
  for (const r of rows) {
    const key = r.stage.toLowerCase() as keyof typeof s;
    if (key !== 'total' && key in s) s[key] += 1;
  }
  return s;
}

function serialize(req: RequisitionFull) {
  return {
    id: req.id,
    code: req.code,
    designation: req.designation,
    grade: req.grade ?? null,
    requirementType: low(req.requirementType),
    source: low(req.source),
    requiredPosts: req.requiredPosts,
    totalVacantPosts: req.totalVacantPosts,
    unitFactory: req.unitFactory,
    department: req.department,
    section: req.section ?? '',
    placeOfPosting: req.placeOfPosting,
    vacantDate: req.vacantDate?.toISOString() ?? null,
    neededDate: req.neededDate?.toISOString() ?? null,
    priority: low(req.priority),
    employmentNature: low(req.employmentNature),
    contractualPurpose: req.contractualPurpose ?? '',
    jobDescription: req.jobDescription,
    education: req.education,
    experience: req.experience,
    others: req.others ?? '',
    facilities: req.facilities ?? null,
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
      createdAt: a.createdAt.toISOString(),
    })),
    roleProfile: req.roleProfile ?? null,
    posting: req.posting ?? null,
    drive: req.drive ?? null,
    attachments: Array.isArray(req.attachments) ? req.attachments : [],
    candidateStats: candidateStats(req.candidates),
    pipeline: pipelineProgress(req.candidates),
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

/** One facility line item: the requisitioner's request + HR's confirm/skip decision. */
export interface FacilityDecision {
  requested: boolean;
  option: string | null;
  note: string;
  status: 'pending' | 'confirmed' | 'skipped';
  hrNote: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export const FACILITY_KEYS = ['laptopDesktop', 'transport', 'dormitory', 'seating'] as const;

export const FACILITY_LABEL: Record<string, string> = {
  laptopDesktop: 'Laptop / Desktop',
  transport: 'Transport Facility',
  dormitory: 'Dormitory Facility',
  seating: 'Seating Arrangement',
};

/** Seed the facilities JSON from the requisitioner's create-time input — HR hasn't acted yet. */
function buildInitialFacilities(
  dto: FacilitiesRequestDto,
): Record<string, FacilityDecision> {
  const result: Record<string, FacilityDecision> = {};
  for (const key of FACILITY_KEYS) {
    const input = dto[key];
    result[key] = {
      requested: input?.requested ?? false,
      option: input?.option ?? null,
      note: input?.note ?? '',
      status: 'pending',
      hrNote: '',
      decidedBy: null,
      decidedAt: null,
    };
  }
  return result;
}

interface RequisitionAttachment {
  name: string;
  fileId: string;
  url: string;
  size: number;
  uploadedBy?: string;
  uploadedAt: string;
}

function readAttachments(req: RequisitionFull): RequisitionAttachment[] {
  return Array.isArray(req.attachments)
    ? (req.attachments as unknown as RequisitionAttachment[])
    : [];
}
