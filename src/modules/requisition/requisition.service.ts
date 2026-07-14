import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { RecruitmentService } from '../candidates/recruitment.service';
import { DriveService } from '../integrations/google/drive.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import { SettingsService } from '../settings/settings.service';
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

    return serialize(updated);
  }

  private async setupDriveWorkspace(
    updated: Awaited<ReturnType<typeof this.load>>,
    raisedById: string | null,
  ): Promise<void> {
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
    requirementType: low(req.requirementType),
    source: low(req.source),
    requiredPosts: req.requiredPosts,
    totalVacantPosts: req.totalVacantPosts,
    unitFactory: req.unitFactory,
    department: req.department,
    section: req.section ?? '',
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
