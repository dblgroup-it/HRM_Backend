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
  ApprovalRole,
  EmploymentNature,
  Prisma,
  Priority,
} from '@prisma/client';

import { FileGrantService } from '../../common/files/file-grant.service';
import { SecureFileService } from '../../common/files/secure-file.service';
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
import { ApprovalPathsService } from '../approval-paths/approval-paths.service';
import { MasterDataService } from '../master-data/master-data.service';
import {
  designationLabel,
  normaliseAlternateDesignations,
  normaliseReplacements,
} from './requisition-inputs';
import { buildMeta, Paginated } from '../../common/dto/pagination.dto';
import {
  CreateRequisitionDto,
  FacilitiesRequestDto,
} from './dto/create-requisition.dto';
import {
  ApprovalActionDto,
  DraftJobAnalysisDto,
  JobAnalysisDto,
  PostRequisitionDto,
  QueryRequisitionsDto,
  UpdateFacilitiesDto,
  UpdateRequisitionDto,
} from './dto/requisition-actions.dto';
import { synthesizeRoleProfile } from './requisition.workflow';

const reqWithRelations = {
  approvalSteps: { orderBy: { orderIndex: 'asc' } },
  replacements: { orderBy: { orderIndex: 'asc' } },
  recruiter: { select: { id: true, name: true, employeeCode: true } },
  jobAnalysisBy: { select: { id: true, name: true } },
  jobAnalysisAssignee: { select: { id: true, name: true } },
  coverRecruiter: { select: { id: true, name: true, employeeCode: true } },
  activities: { orderBy: { createdAt: 'asc' } },
  candidates: {
    // Removed candidates are soft-deleted, and the candidates API filters
    // them out — so counting them here made the tab badges and the pipeline
    // disagree with the list they open: "1 in interview", nobody there.
    where: { deletedAt: null },
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
    private readonly approvalPaths: ApprovalPathsService,
    private readonly masterData: MasterDataService,
    private readonly files: FileGrantService,
    private readonly secureFiles: SecureFileService,
  ) {}

  /**
   * Serialize a requisition for a client.
   *
   * Wraps the module-level `serialize` only to hand it the grant minter, so
   * attachment links resolve to this API rather than to a public Drive URL.
   */
  private ser(req: RequisitionFull) {
    return serialize(req, this.files);
  }

  private readonly logger = new Logger(RequisitionService.name);

  async create(
    dto: CreateRequisitionDto,
    raiser: { id: string; name: string },
  ) {
    await this.ensureCanRaise(raiser.id, dto.unitFactory);

    // New vs Replacement is the requisitioner's declaration, not the
    // organogram's. The seat lookup still runs — it fills totalVacantPosts and
    // shows the requisitioner what's sanctioned — but it is advisory now, so a
    // replacement can be raised for a seat the organogram doesn't yet show.
    await this.organogram.lookup(
      dto.unitFactory,
      dto.department,
      dto.designation,
      raiser.id,
    );
    const requirementType = dto.requirementType === 'new' ? 'NEW' : 'EXISTING';

    // A replacement has to say who left and why — otherwise "Replacement" is
    // an unauditable label. Trimmed here so whitespace can't satisfy it.
    //
    // A requisition can refill several seats at once, so the form sends a list.
    // Older clients send the four single fields instead; normaliseReplacements
    // accepts either and yields one shape. The first entry is mirrored back
    // into those columns below, because the approval sheet, the board export
    // and several reports still read them directly.
    const replacements =
      requirementType === 'EXISTING' ? normaliseReplacements(dto) : [];
    const first = replacements[0] ?? null;
    const replaceOfName = first?.employeeName ?? null;
    const separationReason = first?.separationReason ?? null;

    if (requirementType === 'EXISTING') {
      if (!replaceOfName) {
        throw new BadRequestException(
          'Name the employee being replaced — a replacement requisition must say who left.',
        );
      }
      // Required of everyone listed, not only the first: a sheet naming three
      // leavers with one reason between them is not auditable.
      const missing = replacements.filter((r) => !r.separationReason);
      if (missing.length) {
        throw new BadRequestException(
          replacements.length === 1
            ? 'Give the reason the employee being replaced left.'
            : `Give a separation reason for ${missing.map((r) => r.employeeName).join(', ')}.`,
        );
      }
    }

    // Other levels this post may be filled at. Which one a candidate is
    // actually hired at is settled per person during onboarding.
    const alternateDesignations = normaliseAlternateDesignations(
      dto.designation,
      dto.alternateDesignations,
    );

    // This raiser's own chain for this unit — an ordered list of named
    // approvers with a Head of Talent Acquisition step appended — snapshotted here so later
    // edits to the path never reroute a requisition already in flight.
    // Throws a clear error when this raiser has no path configured here.
    const steps = await this.approvalPaths.buildStepsForRaiser(
      dto.unitFactory,
      raiser.id,
      dto.department,
    );

    // Who this unit's job analysis is addressed to: the first Factory HR in the
    // layering who is not on leave. Null on a unit that never set an order
    // (it goes to all of them, as before) or one with nobody available at all.
    const jobAnalysisOwners = await this.permissions.jobAnalysisOwners(
      dto.unitFactory,
    );

    // The raiser signs on submit, but that signature is an activity-log entry
    // (and prints on the form) rather than a step in the chain.
    const raisedBy = dto.signatories.departmentHeadName || raiser.name;

    const created = await this.prisma.requisition.create({
      data: {
        code: await this.nextCode(),
        designation: dto.designation,
        alternateDesignations,
        requirementType,
        requiredPosts: dto.requiredPosts,
        totalVacantPosts: dto.totalVacantPosts,
        unitFactory: dto.unitFactory,
        lineOfBusiness: dto.lineOfBusiness,
        department: dto.department,
        section: dto.section ?? null,
        subSection: dto.subSection ?? null,
        // Only meaningful on a replacement; cleared on a NEW headcount so a
        // later edit from Replace to New can't leave a stale name behind.
        replaceOfName: requirementType === 'EXISTING' ? replaceOfName : null,
        replaceOfEmployeeCode: first?.employeeCode ?? null,
        separationReason:
          requirementType === 'EXISTING' ? separationReason : null,
        replacementRemarks: first?.remarks ?? null,
        // The full list. Empty on a NEW headcount, so switching a requisition
        // from Replace to New cannot leave orphaned names behind.
        replacements: { create: replacements },
        placeOfPosting: dto.placeOfPosting,
        vacantDate: toDate(dto.vacantDate),
        neededDate: toDate(dto.neededDate),
        priority: dto.priority.toUpperCase() as Priority,
        employmentNature:
          dto.employmentNature.toUpperCase() as EmploymentNature,
        contractualPurpose: dto.contractualPurpose ?? null,
        // Section B is the Factory HR's to write at the next stage; the
        // columns stay NOT NULL and start empty rather than nullable, so
        // nothing downstream has to learn a third state.
        jobDescription: '',
        education: '',
        experience: '',
        others: null,
        facilities: buildInitialFacilities(
          dto.facilities,
        ) as unknown as Prisma.InputJsonValue,
        preferredSources: [],
        // Not in the chain yet: the unit's Factory HR completes the job
        // analysis first (see saveJobAnalysis).
        status: 'PENDING_JOB_ANALYSIS',
        jobAnalysisAssigneeId: jobAnalysisOwners.assigneeId,
        raisedBy,
        raisedById: raiser.id,
        approvalSteps: { create: steps },
        activities: {
          create: [
            {
              actor: raisedBy,
              action: 'APPROVED',
              note: 'Raised & signed by the Requisition Raiser — awaiting job analysis',
            },
          ],
        },
      },
      include: reqWithRelations,
    });

    const serialized = this.ser(created);
    this.notifications.broadcastChange('requisition', created.id, {
      action: 'created',
      record: serialized,
    });
    await this.notifyJobAnalysisOwners(created);

    return serialized;
  }

  // --- Stage 2: the job analysis (Factory HR) ------------------------------

  /**
   * Section B and the attachments, written after the requisition is raised.
   *
   * The requisitioner states the vacancy and what the hire will need; the job
   * description and specification are the unit's Factory HR's to write, because
   * they are the ones who know the post. Only when they submit does the
   * configured approval path start — the chain was snapshotted at creation, so
   * it is the path as it stood when the requisition was raised either way.
   *
   * `submit: false` saves progress without releasing it, so a long JD doesn't
   * have to be written in one sitting.
   */
  /**
   * AI-draft section B from section A.
   *
   * The draft is returned, never written: the person who owns the job analysis
   * reviews and edits every field before it is saved, and a draft that nobody
   * submitted should leave no trace on the requisition. Gated on the same
   * rule as writing it by hand — if it is not yours to write, it is not yours
   * to draft.
   */
  async draftJobAnalysis(
    id: string,
    dto: DraftJobAnalysisDto,
    userId: string,
  ) {
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const req = await this.load(id, userId);
    if (req.status !== 'PENDING_JOB_ANALYSIS') {
      throw new BadRequestException(
        'The job analysis can only be drafted before the requisition enters its approval chain',
      );
    }
    await this.permissions.requireJobAnalysisAccess(
      userId,
      req.unitFactory,
      req.jobAnalysisAssigneeId,
      'draft the job analysis',
    );

    return this.ai.draftJobAnalysis({
      designation: req.designation,
      department: req.department,
      section: req.section,
      unitFactory: req.unitFactory,
      placeOfPosting: req.placeOfPosting,
      requiredPosts: req.requiredPosts,
      employmentNature: req.employmentNature.toLowerCase(),
      grade: req.grade,
      requirementType: req.requirementType.toLowerCase(),
      current: {
        jobDescription: dto.jobDescription ?? req.jobDescription,
        education: dto.education ?? req.education,
        experience: dto.experience ?? req.experience,
        others: dto.others ?? req.others ?? '',
      },
      hint: dto.hint ?? null,
    });
  }

  async saveJobAnalysis(
    id: string,
    dto: JobAnalysisDto,
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    if (req.status !== 'PENDING_JOB_ANALYSIS') {
      throw new BadRequestException(
        req.status === 'PENDING_APPROVAL' || req.status === 'REJECTED'
          ? `${req.code} has already gone to its approvers — ask the current approver to edit it.`
          : 'The job analysis can only be written before the requisition enters its approval chain',
      );
    }
    await this.permissions.requireJobAnalysisAccess(
      actor.id,
      req.unitFactory,
      req.jobAnalysisAssigneeId,
    );

    const submit = dto.submit !== false;
    const jobDescription = (dto.jobDescription ?? req.jobDescription).trim();
    const education = (dto.education ?? req.education).trim();
    const experience = (dto.experience ?? req.experience).trim();
    const others = (dto.others ?? req.others ?? '').trim();

    if (submit) {
      // Checked here rather than on the DTO so a part-written draft can still
      // be saved: the requirement is on releasing it, not on typing into it.
      const missing = [
        jobDescription.length < 5 ? 'a job description' : null,
        education ? null : 'the education & training requirement',
        experience ? null : 'the experience requirement',
      ].filter((v): v is string => Boolean(v));
      if (missing.length) {
        throw new BadRequestException(
          `Complete the job analysis before sending it for approval — still missing ${missing.join(', ')}.`,
        );
      }
    }

    const updated = await this.prisma.requisition.update({
      where: { id },
      data: {
        jobDescription,
        education,
        experience,
        others: others || null,
        ...(submit
          ? {
              status: 'PENDING_APPROVAL' as const,
              jobAnalysisById: actor.id,
              jobAnalysisAt: new Date(),
              // A submitted requisition is no longer parked with the raiser.
              jobAnalysisReturnedAt: null,
              jobAnalysisReturnNote: null,
              activities: {
                create: {
                  actor: actor.name,
                  action: 'EDITED' as const,
                  note: 'Job analysis completed — sent to the approval chain',
                },
              },
            }
          : {}),
      },
      include: reqWithRelations,
    });

    const serialized = this.ser(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: submit ? 'job_analysis_completed' : 'updated',
      record: serialized,
    });
    if (submit) {
      await this.notifyPendingApprover(updated);
      if (updated.raisedById && updated.raisedById !== actor.id) {
        await this.notifications.notifyMany([updated.raisedById], {
          type: 'requisition_info',
          title: 'Job analysis completed',
          message: `${updated.code} · ${updated.designation} — ${actor.name} completed the job analysis and sent it for approval.`,
          link: `/requisitions/${updated.id}`,
        });
      }
    }
    return serialized;
  }

  /**
   * Who owns this requisition's job analysis, and may the caller write it?
   *
   * Answered by the server because the rule depends on who holds Factory HR
   * for the unit — the page would otherwise have to guess, and offer a form
   * that saving then rejects.
   */
  async jobAnalysisOwnership(id: string, userId: string) {
    const req = await this.load(id, userId);
    const [{ viaFactoryHr, holders }, canComplete] = await Promise.all([
      this.permissions.jobAnalysisOwnerHolders(req.unitFactory),
      this.permissions.canCompleteJobAnalysis(
        userId,
        req.unitFactory,
        req.jobAnalysisAssigneeId,
      ),
    ]);
    return {
      canComplete,
      viaFactoryHr,
      /** The unit's HR layering, in order, with who is away. */
      owners: holders,
      assignee: req.jobAnalysisAssignee
        ? {
            id: req.jobAnalysisAssignee.id,
            name: req.jobAnalysisAssignee.name,
          }
        : null,
    };
  }

  /**
   * Factory HR hands the requisition back to the raiser instead of completing
   * it — the vacancy details are the raiser's to fix, and a wrong designation
   * or post count can't be corrected from the job-analysis side.
   *
   * It stays at PENDING_JOB_ANALYSIS: nobody in the chain holds it, and the
   * return note says whose turn it is. Mirrors "need more info" mid-chain.
   */
  async returnJobAnalysisToRaiser(
    id: string,
    note: string,
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    if (req.status !== 'PENDING_JOB_ANALYSIS') {
      throw new BadRequestException(
        'Only a requisition awaiting its job analysis can be sent back to the raiser',
      );
    }
    await this.permissions.requireJobAnalysisAccess(
      actor.id,
      req.unitFactory,
      req.jobAnalysisAssigneeId,
      'send this requisition back to the raiser',
    );
    const reason = note.trim();
    if (!reason) {
      throw new BadRequestException(
        'Say what needs changing — the raiser gets only this note',
      );
    }

    const updated = await this.prisma.requisition.update({
      where: { id },
      data: {
        jobAnalysisReturnedAt: new Date(),
        jobAnalysisReturnNote: reason,
        activities: {
          create: {
            actor: actor.name,
            action: 'NEED_MORE_INFO' as const,
            note: `Returned to the requisitioner before job analysis: ${reason}`,
          },
        },
      },
      include: reqWithRelations,
    });

    const serialized = this.ser(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'returned_to_raiser',
      record: serialized,
    });
    if (updated.raisedById) {
      await this.notifications.notifyMany([updated.raisedById], {
        type: 'requisition_info_requested',
        title: `${updated.code} sent back to you`,
        message: `${actor.name} needs changes before the job analysis: ${reason}`,
        link: `/requisitions/${updated.id}`,
      });
    }
    return serialized;
  }

  /**
   * The raiser resends a returned requisition. Clears the return note and puts
   * it back in front of whoever owns the job analysis.
   */
  async resendForJobAnalysis(id: string, actor: { id: string; name: string }) {
    const req = await this.load(id, actor.id);
    if (req.status !== 'PENDING_JOB_ANALYSIS' || !req.jobAnalysisReturnedAt) {
      throw new BadRequestException(
        `${req.code} is not waiting on the requisitioner`,
      );
    }
    const isSuper = await this.permissions.isSuperUser(actor.id);
    if (req.raisedById !== actor.id && !isSuper) {
      throw new ForbiddenException(
        `Only ${req.raisedBy || 'the requisitioner'} can resend ${req.code}`,
      );
    }

    const updated = await this.prisma.requisition.update({
      where: { id },
      data: {
        jobAnalysisReturnedAt: null,
        jobAnalysisReturnNote: null,
        activities: {
          create: {
            actor: actor.name,
            action: 'EDITED' as const,
            note: 'Amended and resent for job analysis',
          },
        },
      },
      include: reqWithRelations,
    });

    const serialized = this.ser(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'resubmitted',
      record: serialized,
    });
    await this.notifyJobAnalysisOwners(updated);
    return serialized;
  }

  /**
   * Tell whoever owns the job analysis that one is waiting.
   *
   * The unit's Factory HR, or — where the unit has none — Head of Talent
   * Acquisition and the Corporate Recruiters, who cover for it.
   */
  private async notifyJobAnalysisOwners(req: RequisitionFull): Promise<void> {
    // Parked with the raiser: nobody is waiting on the job analysis yet.
    if (req.jobAnalysisReturnedAt) return;
    const owners = await this.permissions.jobAnalysisOwners(req.unitFactory);
    // Addressed to somebody already — tell them, not the whole queue. The
    // stored assignee wins over today's answer so a resend goes back to the
    // person who has been holding it.
    const userIds = req.jobAnalysisAssigneeId
      ? [req.jobAnalysisAssigneeId]
      : owners.userIds;
    const viaFactoryHr = req.jobAnalysisAssigneeId ? true : owners.viaFactoryHr;
    if (!userIds.length) {
      this.logger.warn(
        `${req.code}: nobody holds Factory HR for ${req.unitFactory} and no Head of Talent Acquisition / recruiter to fall back on — the job analysis has no owner`,
      );
      return;
    }
    await this.notifications.notifyMany(userIds, {
      type: 'requisition_pending',
      title: 'Job analysis needed',
      message: `${req.code} · ${req.designation} (${req.unitFactory}) needs its job analysis${
        viaFactoryHr ? '' : ' — this unit has no Factory HR'
      }.`,
      link: `/requisitions/${req.id}`,
    });
  }

  /**
   * Who may act on a given step: the named approver on a configured step, or
   * — for legacy chains and the CHRO step appended on escalation — whoever
   * holds that step's role for the unit. Super users always pass.
   */
  private async canActOnStep(
    step: { role: ApprovalRole | null; approverUserId: string | null },
    unitName: string,
    userId: string,
  ): Promise<boolean> {
    if (step.approverUserId) {
      if (step.approverUserId === userId) return true;
      return this.permissions.isSuperUser(userId);
    }
    if (!step.role) return this.permissions.isSuperUser(userId);
    return this.permissions.hasRoleForUnitName(
      userId,
      step.role.toLowerCase(),
      unitName,
    );
  }

  /** Notify whoever currently needs to act on a requisition. */
  private async notifyPendingApprover(req: RequisitionFull): Promise<void> {
    // Parked with the raiser — nobody in the chain is waiting on anything yet.
    if (req.approvalSteps.some((s) => s.status === 'INFO_REQUESTED')) return;
    const pending = req.approvalSteps.find((s) => s.status === 'PENDING');
    if (!pending) return;
    const userIds = pending.approverUserId
      ? [pending.approverUserId]
      : pending.role
        ? await this.permissions.roleHolderUserIds(
            pending.role.toLowerCase(),
            req.unitFactory,
          )
        : [];
    await this.notifications.notifyMany(userIds, {
      type: 'requisition_pending',
      title: `${pending.title} approval needed`,
      message: `${req.code} · ${req.designation} (${req.unitFactory}) awaits your approval.`,
      link: `/requisitions/${req.id}`,
    });
  }

  /**
   * Requisitioner sends a clarified requisition back into the chain.
   *
   * Approvals given before the bounce are cleared: they were signed against
   * content that has since changed, so the chain restarts from step 1 rather
   * than binding an earlier approver to a version they never saw.
   */
  async resubmit(id: string, actor: { id: string; name: string }) {
    const req = await this.load(id, actor.id);

    if (req.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Only a requisition awaiting approval can be resent',
      );
    }
    if (!req.approvalSteps.some((s) => s.status === 'INFO_REQUESTED')) {
      throw new BadRequestException(
        `${req.code} is not waiting on clarification`,
      );
    }
    const isSuper = await this.permissions.isSuperUser(actor.id);
    if (req.raisedById !== actor.id && !isSuper) {
      throw new ForbiddenException(
        `Only ${req.raisedBy || 'the requisitioner'} can resend ${req.code} for approval`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.approvalStep.updateMany({
        where: { requisitionId: id },
        data: { status: 'PENDING', note: '', actedAt: null },
      });
      await tx.requisitionActivity.create({
        data: {
          requisitionId: id,
          actor: actor.name,
          action: 'EDITED',
          note: 'Clarified and resent for approval — chain restarted from the first step.',
        },
      });
    });

    const updated = await this.load(id, actor.id);
    await this.notifyPendingApprover(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'resubmitted',
    });
    return this.ser(updated);
  }

  /**
   * What this user is allowed to see in the requisition list.
   *
   * Head of Talent Acquisition / CHRO / super see everything. Everyone else sees only their
   * own business — requisitions they raised, ones they're named on the chain
   * of, or ones they've been assigned to recruit. Holding a unit-scoped role
   * does NOT expose the whole unit's requisitions: a raiser shouldn't see a
   * colleague's requisition just because they share a unit.
   *
   * Shared by findAll and stats so the tiles can never count something the
   * list won't show.
   */
  private async visibilityClause(
    userId: string,
    unitFactory?: string,
  ): Promise<Prisma.RequisitionWhereInput | undefined> {
    // The permission rule itself lives in PermissionsService so the list, the
    // stat tiles and the dashboard all count the same set.
    const allowed = await this.permissions.requisitionVisibility(userId);
    const unitFilter =
      unitFactory && unitFactory !== 'all'
        ? { unitFactory: { equals: unitFactory, mode: 'insensitive' as const } }
        : undefined;

    if (!allowed) return unitFilter;
    return unitFilter ? { AND: [unitFilter, allowed] } : allowed;
  }

  async findAll(
    query: QueryRequisitionsDto,
    userId: string,
  ): Promise<Paginated<unknown>> {
    const { page, pageSize, search, status, unitFactory } = query;
    const scopeClause = await this.visibilityClause(userId, unitFactory);

    // Scope and search are combined under AND: both are OR-shaped, and a plain
    // object spread would silently drop one of them.
    const where: Prisma.RequisitionWhereInput = {
      deletedAt: null,
      ...(status && status !== 'all'
        ? { status: status.toUpperCase() as Prisma.EnumRequisitionStatusFilter }
        : {}),
      AND: [
        ...(scopeClause ? [scopeClause] : []),
        ...(search
          ? [
              {
                OR: [
                  {
                    designation: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                  { code: { contains: search, mode: 'insensitive' as const } },
                  {
                    department: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    unitFactory: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                ],
              },
            ]
          : []),
      ],
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
      items: rows.map((r) => this.ser(r)),
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

    // The form's fixed vocabulary, so the AI picks real options rather than
    // free text that the form would only discard.
    const master = await this.masterData.getAll();

    return this.ai.draftRequisition({
      prompt: clean,
      units,
      vocabulary: {
        departments: master.departments,
        designations: master.designations,
        jobLocations: master.jobLocations,
        departmentSections: master.departmentSections,
        sectionSubSections: master.sectionSubSections,
      },
      today: new Date().toISOString().slice(0, 10),
    });
  }

  /**
   * Counts per status for the tiles/chips — computed in the database so the
   * page never has to pull every requisition just to count them.
   */
  async stats(query: QueryRequisitionsDto, userId: string) {
    const { search, unitFactory } = query;
    const scopeClause = await this.visibilityClause(userId, unitFactory);

    const where: Prisma.RequisitionWhereInput = {
      deletedAt: null,
      AND: [
        ...(scopeClause ? [scopeClause] : []),
        ...(search
          ? [
              {
                OR: [
                  {
                    designation: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                  { code: { contains: search, mode: 'insensitive' as const } },
                  {
                    department: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    unitFactory: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                ],
              },
            ]
          : []),
      ],
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
    return this.ser(req);
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

    // Parked with the raiser after "need more info" — later steps are still
    // PENDING, so without this guard an approver further down the chain could
    // sign off on a requisition that is currently being rewritten.
    if (steps.some((s) => s.status === 'INFO_REQUESTED')) {
      throw new BadRequestException(
        `${req.code} was sent back to ${req.raisedBy || 'the requisitioner'} for clarification — it returns to the chain once they resend it.`,
      );
    }

    const idx = steps.findIndex((s) => s.status === 'PENDING');
    if (idx === -1) {
      throw new BadRequestException('No pending sign-off to act on');
    }

    const current = steps[idx];

    // Enforce: only this step's named approver (or, on legacy/CHRO steps, a
    // holder of its role for this unit) may act. Super users always may.
    const allowed = await this.canActOnStep(current, req.unitFactory, actor.id);
    if (!allowed) {
      throw new ForbiddenException(
        current.approverUserId
          ? `Only ${current.assignee} can action the "${current.title}" step`
          : `You don't hold the "${current.title}" role for ${req.unitFactory}`,
      );
    }

    // Escalation is offered on the final step of the chain.
    if (dto.decision === 'escalate' && idx !== steps.length - 1) {
      throw new BadRequestException(
        'Only the final approver can escalate to the CHRO',
      );
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
      // Claim the step before doing anything else. `load()` read it outside
      // this transaction, so two approvers (or one approver clicking twice)
      // can both arrive here believing the same step is still PENDING; the
      // conditional update lets exactly one of them through and the other is
      // told the step has moved on, instead of both writing a decision and
      // both appending to the activity log.
      const claimed = await tx.approvalStep.updateMany({
        where: { id: current.id, status: 'PENDING' },
        data: { status: 'PENDING' },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException(
          'This sign-off has already been actioned — reload to see its current state.',
        );
      }

      await tx.requisitionActivity.create({
        data: { requisitionId: id, actor: actorName, action, note },
      });

      if (dto.decision === 'escalate') {
        // Head of Talent Acquisition signs off, then a CHRO step is appended for final approval.
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
        // Straight back to the requisitioner — they wrote it, so they are the
        // one who can answer. The step is held (not approved, not rejected) so
        // the chain resumes from the top once they resend.
        await tx.approvalStep.update({
          where: { id: current.id },
          data: {
            status: 'INFO_REQUESTED',
            assignee: actorName,
            note,
            actedAt: new Date(),
          },
        });
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
            record: this.ser(regenerated),
          });
          return this.ser(regenerated);
        } catch (err) {
          this.logger.warn(
            `Auto role-profile failed: ${(err as Error).message}`,
          );
        }
      }
    }
    return this.ser(updated);
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
      record: this.ser(req),
    });

    if (req.status === 'APPROVED') {
      if (req.raisedById) {
        await this.notifications.notify(req.raisedById, {
          type: 'requisition_approved',
          title: 'Requisition fully approved',
          message: `${req.code} · ${req.designation} is approved — Head of Talent Acquisition will continue.`,
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
    const footing = await this.requireEditAccess(req, actor.id);

    const nextGrade =
      dto.grade !== undefined ? dto.grade.trim() || null : undefined;

    /**
     * Every field this edit actually changed, in words.
     *
     * The requisition is what the chain signed and what the offer is written
     * from, and it can now be corrected by the HR side at any point in its
     * life — so "who changed what, and when" cannot be left to whoever
     * remembers. Only real changes are recorded: sending a field back
     * unchanged is not an edit and should not read as one in the log.
     */
    const changes = describeRequisitionEdit(req, dto, nextGrade);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (changes.length > 0) {
        await tx.requisitionActivity.create({
          data: {
            requisitionId: id,
            actor: actor.name,
            action: 'EDITED',
            // The footing matters as much as the change: an edit by the
            // approver holding it is part of the flow, one made by HR after
            // approval is a correction to a signed document.
            note:
              (footing === 'holder'
                ? ''
                : `Edited by ${footing === 'super' ? 'a super user' : 'HR'}${
                    req.status === 'PENDING_APPROVAL'
                      ? ' while in the approval chain'
                      : req.status === 'PENDING_JOB_ANALYSIS'
                        ? ''
                        : ' after approval'
                  } — `) + changes.join('; '),
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
          ...(dto.experience !== undefined
            ? { experience: dto.experience }
            : {}),
          ...(dto.others !== undefined ? { others: dto.others } : {}),
        },
        include: reqWithRelations,
      });
    });
    const serialized = this.ser(updated);
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
   * Head, Head of Talent Acquisition — whoever's turn it is) or a super user may act, same
   * as `update()`. Once approved, there's no more pending step — so from that
   * point on Head of Talent Acquisition / CHRO / super users may keep re-confirming or
   * changing a decision (e.g. from the Onboarding page, right up to joining).
   */
  async updateFacilities(
    id: string,
    dto: UpdateFacilitiesDto,
    actor: { id: string; name: string },
  ) {
    const req = await this.load(id, actor.id);
    await this.requireFacilitiesEditAccess(req, actor.id);

    const current = (req.facilities ?? {}) as unknown as Record<
      string,
      FacilityDecision
    >;
    const next: Record<string, FacilityDecision> = { ...current };
    const changes: { key: string; note: string }[] = [];
    for (const d of dto.decisions ?? []) {
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
      if (
        existing.status === d.status &&
        (existing.hrNote ?? '') === (d.hrNote ?? '')
      ) {
        continue; // no-op — don't log or touch decidedBy/decidedAt for an unchanged decision
      }
      // HR can grant a facility the requisitioner never asked for. Marking it
      // requested is what makes it visible to Facility Provisioning, which
      // lists only requested + confirmed facilities.
      const added = d.status === 'confirmed' && !existing.requested;
      const verb = d.status === 'confirmed' ? 'Confirmed' : 'Skipped';
      const label = FACILITY_LABEL[d.key] ?? d.key;
      changes.push({
        key: d.key,
        note: added
          ? `Added and confirmed ${label} (not requested by the requisitioner)${d.hrNote ? ` — "${d.hrNote}"` : ''}`
          : existing.status === 'pending'
            ? `${verb} ${label}${d.hrNote ? ` — "${d.hrNote}"` : ''}`
            : `Changed ${label} from ${existing.status} to ${d.status}${d.hrNote ? ` — "${d.hrNote}"` : ''}`,
      });
      next[d.key] = {
        ...existing,
        requested: existing.requested || d.status === 'confirmed',
        status: d.status,
        hrNote: d.hrNote ?? existing.hrNote ?? '',
        decidedBy: actor.name,
        decidedAt: new Date().toISOString(),
      };
    }

    // Fixed appointment terms — the bonus share, the salary review, the tax
    // line. Stored beside the facility decisions because they are settled by
    // the same people at the same moment, and they travel with the
    // requisition rather than with any one candidate.
    if (dto.specialNotes) {
      const before = Array.isArray(current.specialNotes)
        ? (current.specialNotes as unknown as string[])
        : [];
      const after = [
        ...new Set(dto.specialNotes.map((n) => n.trim()).filter(Boolean)),
      ];
      if (before.join('|') !== after.join('|')) {
        changes.push({
          key: 'specialNotes',
          note: after.length
            ? `Set special notes: ${after.join('; ')}`
            : 'Cleared the special notes',
        });
      }
      (next as unknown as Record<string, unknown>).specialNotes = after;
    }

    // Nothing to write: a repeated decision and an unchanged note list.
    if (!changes.length && !dto.specialNotes) return this.ser(req);

    // Fixed appointment terms — the bonus share, the salary review, the tax
    // line. Stored beside the facility decisions because they are settled by
    // the same people at the same moment, and they travel with the
    // requisition rather than with any one candidate.
    if (dto.specialNotes) {
      const before = Array.isArray(current.specialNotes)
        ? (current.specialNotes as unknown as string[])
        : [];
      const after = [
        ...new Set(dto.specialNotes.map((n) => n.trim()).filter(Boolean)),
      ];
      if (before.join('|') !== after.join('|')) {
        changes.push({
          key: 'specialNotes',
          note: after.length
            ? `Set special notes: ${after.join('; ')}`
            : 'Cleared the special notes',
        });
      }
      (next as unknown as Record<string, unknown>).specialNotes = after;
    }

    // Nothing to write: a repeated decision and an unchanged note list.
    if (!changes.length && !dto.specialNotes) return this.ser(req);

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const c of changes) {
        await tx.requisitionActivity.create({
          data: {
            requisitionId: id,
            actor: actor.name,
            action: 'EDITED',
            note: c.note,
          },
        });
      }
      return tx.requisition.update({
        where: { id },
        data: { facilities: next as unknown as Prisma.InputJsonValue },
        include: reqWithRelations,
      });
    });
    const serialized = this.ser(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'updated',
      record: serialized,
    });
    return serialized;
  }

  /** Requisitions can only be edited/have facilities decided by whoever's turn it currently is. */
  /**
   * May this person edit the requisition's content, and on what footing?
   *
   * Two different rights, and they are not the same thing:
   *
   * - **Whoever holds it** — the current approver, or the raiser while it is
   *   parked with them. Their edit is part of the flow: they were asked a
   *   question and the answer is a correction.
   * - **The HR side** — Head of Talent Acquisition / CHRO for the unit, the
   *   assigned Corporate Recruiter (or whoever is covering them), and the
   *   unit's Factory HR. They own the requisition as a document: a wrong
   *   grade, a mistyped post count or a designation that does not match the
   *   seat is theirs to fix, and it should not require bouncing the whole
   *   chain back to the raiser to do it.
   *
   * Which one applied is returned, because `update()` writes it into the
   * activity log: an edit by the approver who is holding a requisition reads
   * very differently from one made by HR after it was approved, and the log
   * is the only place that distinction survives.
   */
  private async requireEditAccess(
    req: RequisitionFull,
    actorId: string,
  ): Promise<'holder' | 'hr' | 'super'> {
    if (await this.permissions.isSuperUser(actorId)) return 'super';

    /**
     * Still open for change at all.
     *
     * Once the last approver has signed, the requisition is the document the
     * chain approved and the offer is written from — so it stops being
     * editable by the unit side. Corporate keeps the pen (below): a wrong
     * grade still has to be fixable after approval, and every change they
     * make is written into the activity log.
     */
    const inChain =
      req.status === 'PENDING_JOB_ANALYSIS' || req.status === 'PENDING_APPROVAL';

    const [isCorporateHr, isChro, isFactoryHr] = await Promise.all([
      this.permissions.hasRoleForUnitName(actorId, 'corporate_hr', req.unitFactory),
      this.permissions.hasRoleForUnitName(actorId, 'chro', req.unitFactory),
      this.permissions.hasRoleForUnitName(actorId, 'factory_hr', req.unitFactory),
    ]);
    const isRecruiter =
      req.recruiterId === actorId ||
      (req.coverRecruiterId === actorId &&
        (!req.coverUntil || req.coverUntil.getTime() > Date.now()));

    // Corporate and the recruiter running the hire own the document for its
    // whole life.
    if (isCorporateHr || isChro || isRecruiter) return 'hr';
    // The unit's Factory HR owns it only while it is still in the chain.
    if (isFactoryHr) {
      if (inChain) return 'hr';
      throw new ForbiddenException(
        `${req.code} has been approved — it can no longer be changed here. Ask Head of Talent Acquisition or the assigned recruiter if something has to be corrected.`,
      );
    }

    await this.requireCurrentApprover(req, actorId);
    return 'holder';
  }

  /**
   * May this person add or remove the requisition's files?
   *
   * The same rule as editing it, and for the same reason: the detailed JD is
   * part of what the chain signed off. Attachments had no gate at all beyond
   * "can you see this requisition", so anyone who could open an approved
   * requisition could delete the JD out of it.
   */
  private async requireAttachmentAccess(
    req: RequisitionFull,
    actorId: string,
    action: string,
  ): Promise<void> {
    try {
      await this.requireEditAccess(req, actorId);
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof BadRequestException) {
        throw new ForbiddenException(
          `${err.message} (${action} on ${req.code})`,
        );
      }
      throw err;
    }
  }

  private async requireCurrentApprover(
    req: RequisitionFull,
    actorId: string,
  ): Promise<void> {
    // Before the chain starts, the content is the raiser's own — but only
    // while Factory HR has actually handed it back to them. Otherwise it sits
    // with the job analysis, and section A is not theirs to rewrite.
    if (req.status === 'PENDING_JOB_ANALYSIS') {
      if (!req.jobAnalysisReturnedAt) {
        throw new BadRequestException(
          `${req.code} is with ${req.unitFactory}'s Factory HR for its job analysis — it can't be edited until it comes back or goes on for approval.`,
        );
      }
      if (
        req.raisedById === actorId ||
        (await this.permissions.isSuperUser(actorId))
      ) {
        return;
      }
      throw new ForbiddenException(
        `${req.code} was sent back to ${req.raisedBy || 'the requisitioner'} — only they can edit it now.`,
      );
    }
    if (req.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Only requisitions awaiting approval can be edited',
      );
    }
    // Sent back for clarification: it is the raiser's to fix, not an approver's.
    if (req.approvalSteps.some((s) => s.status === 'INFO_REQUESTED')) {
      if (
        req.raisedById === actorId ||
        (await this.permissions.isSuperUser(actorId))
      ) {
        return;
      }
      throw new ForbiddenException(
        `${req.code} was sent back to ${req.raisedBy || 'the requisitioner'} — only they can edit it now.`,
      );
    }

    const current = req.approvalSteps.find((s) => s.status === 'PENDING');
    if (!current) throw new BadRequestException('No pending step to edit on');

    const allowed = await this.canActOnStep(current, req.unitFactory, actorId);
    if (!allowed) {
      throw new ForbiddenException(
        `Only ${current.assignee || 'the current approver'}, ${req.unitFactory}'s Factory HR, the assigned recruiter or Head of Talent Acquisition can edit this requisition`,
      );
    }
  }

  /**
   * Facilities are settled by the HR side, not by the sign-off chain.
   *
   * Confirming a laptop or a desk is a provisioning commitment, so it belongs
   * to Head of Talent Acquisition / CHRO and the assigned Corporate Recruiter — the people
   * who actually deliver it — rather than to whichever approver happens to
   * hold the requisition at that moment. The same gate applies before and
   * after approval, so a decision can't be made by one party and revised by a
   * different one.
   */
  private async requireFacilitiesEditAccess(
    req: RequisitionFull,
    actorId: string,
  ): Promise<void> {
    await this.permissions.requireRecruitmentAccess(
      actorId,
      req.unitFactory,
      req.recruiterId,
      'confirm or skip facility requests',
      { userId: req.coverRecruiterId, until: req.coverUntil },
    );
  }

  /** Step 3 — generate the AI role profile. Head of Talent Acquisition owns this step. */
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
    const serialized = this.ser(updated);
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

  /** Save Head of Talent Acquisition's manual edits to the role profile. */
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
    const serialized = this.ser(updated);
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

  /** Step 4 — publish to candidate sources. Head of Talent Acquisition owns this step. */
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
      // Every posted requisition goes to the DBL career page; the channel list
      // the requisitioner used to pick from is gone. Kept as an array because
      // requisitions posted before this still hold their own sources.
      sources: ['career_page'],
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

    return this.ser(updated);
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
      const serialized = this.ser(fresh);
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
    await this.requireAttachmentAccess(req, actor.id, 'adding a file');
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
    // The file stays private to the recruitment Google account. Anyone who may
    // see the requisition streams the attachment through this API instead of
    // opening a permanent public Drive link.
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
    const serialized = this.ser(updated);
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
    await this.requireAttachmentAccess(req, actor.id, 'removing a file');
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
    const serialized = this.ser(updated);
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
    // Mirrors `visibilityClause`: you reach a requisition if it's your own
    // business — you raised it, you're named on its chain, or you're its
    // recruiter — otherwise only Head of Talent Acquisition / CHRO / super (all-unit scope).
    // Holding a unit-scoped role is deliberately not enough.
    if (userId) {
      const isOwnBusiness =
        req.raisedById === userId ||
        req.recruiterId === userId ||
        req.jobAnalysisById === userId ||
        req.jobAnalysisAssigneeId === userId ||
        // Standing in for the recruiter while they are on leave. Checked
        // against the date as well, so a lapsed cover stops opening it.
        (req.coverRecruiterId === userId &&
          (!req.coverUntil || req.coverUntil.getTime() > Date.now())) ||
        req.approvalSteps.some((s) => s.approverUserId === userId);
      if (!isOwnBusiness) {
        const scope = await this.permissions.getUnitAccessScope(userId);
        if (!scope.all) {
          // Waiting on this user's job analysis — they hold Factory HR for the
          // unit (or cover a unit that has none). They are not on the chain and
          // did not raise it, so nothing above matches, and without this the
          // person the requisition is actually waiting on cannot open it.
          const owed =
            req.status === 'PENDING_JOB_ANALYSIS' &&
            (await this.permissions.canCompleteJobAnalysis(
              userId,
              req.unitFactory,
              req.jobAnalysisAssigneeId,
            ));
          if (!owed) {
            throw new ForbiddenException(
              'You can only open requisitions you raised, need to approve, are recruiting for, or owe a job analysis',
            );
          }
        }
      }
    }
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

  /**
   * Raising a requisition needs the Requisition Raiser role for that unit
   * (super users excepted). Deliberately narrower than plain unit access:
   * Factory HR, SBU Head and Unit Approvers can see and sign off on a unit's
   * requisitions without being able to open new ones.
   */
  private async ensureCanRaise(
    userId: string,
    unitName: string,
  ): Promise<void> {
    const allowed = await this.permissions.hasRoleForUnitName(
      userId,
      'requisition_raiser',
      unitName,
    );
    if (!allowed) {
      throw new ForbiddenException(
        `You need the Requisition Raiser role for ${unitName} to raise a requisition there`,
      );
    }
  }

  private async ensureCorporateHrContinuation(
    req: RequisitionFull,
    userId: string,
  ): Promise<void> {
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      'continue this requisition after approval',
      { userId: req.coverRecruiterId, until: req.coverUntil },
    );
  }

  /** The Corporate Recruiter pool for a requisition's unit. */
  async listRecruiters(id: string, userId: string) {
    const req = await this.load(id, userId);
    return this.permissions.roleHolders('corporate_recruiter', req.unitFactory);
  }

  /**
   * Nominate the Corporate Recruiter who owns this requisition's post-approval
   * lifecycle. Additive — Head of Talent Acquisition and CHRO keep their access; this just
   * gives the requisition an owner (and someone to notify).
   */
  async assignRecruiter(
    id: string,
    recruiterId: string | null,
    actor: { id: string; name: string },
  ) {
    // A cover stands in for one particular recruiter. Handing the requisition
    // to somebody else ends that arrangement rather than leaving a stand-in
    // attached to a recruiter who no longer has it.

    const req = await this.load(id, actor.id);

    // Only Head of Talent Acquisition / CHRO / super may nominate — deliberately NOT the
    // current recruiter, so a recruiter can't hand the requisition on unasked.
    const allowed =
      (await this.permissions.hasRoleForUnitName(
        actor.id,
        'corporate_hr',
        req.unitFactory,
      )) ||
      (await this.permissions.hasRoleForUnitName(
        actor.id,
        'chro',
        req.unitFactory,
      ));
    if (!allowed) {
      throw new ForbiddenException(
        'Only Head of Talent Acquisition, CHRO or a super user can assign a recruiter',
      );
    }

    if (req.status === 'PENDING_APPROVAL' || req.status === 'REJECTED') {
      throw new BadRequestException(
        'A recruiter can only be assigned once the requisition is approved',
      );
    }

    let recruiterName = '';
    if (recruiterId) {
      const recruiter = await this.prisma.user.findUnique({
        where: { id: recruiterId },
        select: { id: true, name: true, status: true },
      });
      if (!recruiter) throw new NotFoundException('Recruiter not found');
      if (recruiter.status !== 'ACTIVE') {
        throw new BadRequestException(
          `${recruiter.name} is not an active user`,
        );
      }
      const holds = await this.permissions.hasRoleForUnitName(
        recruiterId,
        'corporate_recruiter',
        req.unitFactory,
      );
      if (!holds) {
        throw new BadRequestException(
          `${recruiter.name} does not hold the Corporate Recruiter role — grant it in Access Control first`,
        );
      }
      recruiterName = recruiter.name;
    }

    await this.prisma.requisition.update({
      where: { id },
      data: {
        recruiterId,
        recruiterAssignedAt: recruiterId ? new Date() : null,
        recruiterAssignedById: recruiterId ? actor.id : null,
        // See the note above: the stand-in stood in for the previous recruiter.
        coverRecruiterId: null,
        coverLeaveId: null,
        coverUntil: null,
      },
    });

    await this.prisma.requisitionActivity.create({
      data: {
        requisitionId: id,
        actor: actor.name,
        action: 'EDITED',
        note: recruiterId
          ? `Assigned ${recruiterName} as Corporate Recruiter`
          : 'Cleared the assigned Corporate Recruiter',
      },
    });

    if (recruiterId) {
      await this.notifications.notifyMany([recruiterId], {
        type: 'requisition_recruiter_assigned',
        title: 'You are the recruiter for a requisition',
        message: `${req.code} · ${req.designation} (${req.unitFactory}) is now yours to run.`,
        link: `/requisitions/${id}`,
      });
    }

    const updated = await this.load(id, actor.id);
    const serialized = this.ser(updated);
    this.notifications.broadcastChange('requisition', id, {
      action: 'updated',
      record: serialized,
    });
    return serialized;
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

/**
 * `attachments[].url` points at THIS API, not at Google Drive.
 *
 * Attachment files stay private to the recruitment Google account; `files`
 * mints a short-lived signed grant per attachment, which is only reached by
 * callers who already passed this requisition's visibility check. Rows written
 * before this change still carry a Drive URL, so those are left as they are
 * until the revoke sweep runs — see scripts/revoke-public-drive-access.ts.
 */
function serialize(req: RequisitionFull, files?: FileGrantService) {
  return {
    id: req.id,
    code: req.code,
    designation: req.designation,
    alternateDesignations: req.alternateDesignations ?? [],
    /**
     * Every level this post may be filled at, primary first, as one string:
     * "Senior Executive / Assistant Manager". Sent so a list, a sheet and a
     * notification cannot each join it differently.
     */
    designationLabel: designationLabel(
      req.designation,
      req.alternateDesignations,
    ),
    grade: req.grade ?? null,
    requirementType: low(req.requirementType),
    lineOfBusiness: req.lineOfBusiness ?? null,
    /** Everyone this requisition replaces. Empty on a NEW headcount. */
    replacements: (req.replacements ?? []).map((r) => ({
      id: r.id,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode ?? null,
      separationReason: r.separationReason ?? null,
      vacantDate: r.vacantDate?.toISOString() ?? null,
      remarks: r.remarks ?? null,
    })),
    // The first replaced employee, kept because existing readers expect it.
    replaceOfName: req.replaceOfName ?? null,
    replaceOfEmployeeCode: req.replaceOfEmployeeCode ?? null,
    separationReason: req.separationReason ?? null,
    replacementRemarks: req.replacementRemarks ?? null,
    requiredPosts: req.requiredPosts,
    totalVacantPosts: req.totalVacantPosts,
    unitFactory: req.unitFactory,
    department: req.department,
    section: req.section ?? '',
    subSection: req.subSection ?? '',
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
    // Lifted out of the facilities blob so the frontend's
    // Record<FacilityKey, …> keeps its shape.
    specialNotes: Array.isArray(
      (req.facilities as { specialNotes?: unknown } | null)?.specialNotes,
    )
      ? (req.facilities as { specialNotes: string[] }).specialNotes
      : [],
    preferredSources: req.preferredSources,
    /**
     * The job-analysis stage: who completed section B, and — while it is still
     * open — whether Factory HR has handed it back to the raiser.
     */
    jobAnalysis: {
      /** The Factory HR it is addressed to — null on an unordered unit. */
      assignee: req.jobAnalysisAssignee
        ? { id: req.jobAnalysisAssignee.id, name: req.jobAnalysisAssignee.name }
        : null,
      completedBy: req.jobAnalysisBy
        ? { id: req.jobAnalysisBy.id, name: req.jobAnalysisBy.name }
        : null,
      completedAt: req.jobAnalysisAt?.toISOString() ?? null,
      returnedAt: req.jobAnalysisReturnedAt?.toISOString() ?? null,
      returnNote: req.jobAnalysisReturnNote ?? null,
    },
    status: low(req.status),
    approvalChain: req.approvalSteps.map((s) => ({
      id: s.id,
      // null on person-routed steps; set on legacy chains and the CHRO step
      // appended on escalation, which still route by role.
      role: s.role ? low(s.role) : null,
      approverUserId: s.approverUserId,
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
    attachments: readAttachments(req).map((a) => ({
      ...a,
      url:
        files?.url(a.fileId, 'requisition-attachment', { filename: a.name }) ??
        a.url,
    })),
    candidateStats: candidateStats(req.candidates),
    pipeline: pipelineProgress(req.candidates),
    raisedBy: req.raisedBy ?? '',
    raisedById: req.raisedById ?? null,
    recruiter: req.recruiter
      ? {
          id: req.recruiter.id,
          name: req.recruiter.name,
          employeeCode: req.recruiter.employeeCode,
        }
      : null,
    recruiterAssignedAt: req.recruiterAssignedAt?.toISOString() ?? null,
    /**
     * The stand-in running this while the recruiter is on leave. Reported only
     * while it actually applies: the row keeps the last cover until someone
     * sets a new one, and a lapsed one must not read as current.
     */
    cover:
      req.coverRecruiter &&
      (!req.coverUntil || req.coverUntil.getTime() > Date.now())
        ? {
            id: req.coverRecruiter.id,
            name: req.coverRecruiter.name,
            employeeCode: req.coverRecruiter.employeeCode,
            until: req.coverUntil?.toISOString() ?? null,
          }
        : null,
    createdAt: req.createdAt.toISOString(),
    updatedAt: req.updatedAt.toISOString(),
  };
}

/**
 * What an edit actually changed, one clause per field.
 *
 * Only real changes: an unchanged value sent back with the form is not an
 * edit and must not appear in the log as one, or the history fills with
 * "Priority changed from moderate to moderate" and stops being read.
 *
 * Short fields print both values, because that is what somebody checking the
 * record wants to see. Long prose does not — a paragraph pasted into an
 * activity note is unreadable and the current text is on the requisition
 * anyway — so those say that they were rewritten and how long the old one
 * was, which is enough to tell a correction from a replacement.
 */
export function describeRequisitionEdit(
  before: {
    grade: string | null;
    requiredPosts: number;
    totalVacantPosts: number | null;
    placeOfPosting: string;
    vacantDate: Date | null;
    neededDate: Date | null;
    priority: string;
    employmentNature: string;
    contractualPurpose: string | null;
    jobDescription: string;
    education: string;
    experience: string;
    others: string | null;
  },
  dto: UpdateRequisitionDto,
  nextGrade: string | null | undefined,
): string[] {
  const out: string[] = [];
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');
  const text = (v: string | null | undefined) => (v ?? '').trim();

  const scalar = (
    label: string,
    was: string | number | null,
    next: string | number | null | undefined,
  ) => {
    if (next === undefined) return;
    if (String(was ?? '') === String(next ?? '')) return;
    out.push(`${label}: ${was || '—'} → ${next || '—'}`);
  };

  scalar('Job Grade', before.grade, nextGrade);
  scalar('Required posts', before.requiredPosts, dto.requiredPosts);
  scalar('Total vacant posts', before.totalVacantPosts, dto.totalVacantPosts);
  scalar('Place of posting', before.placeOfPosting, dto.placeOfPosting);
  scalar('Priority', before.priority.toLowerCase(), dto.priority?.toLowerCase());
  scalar(
    'Employment nature',
    before.employmentNature.toLowerCase(),
    dto.employmentNature?.toLowerCase(),
  );
  scalar('Purpose', before.contractualPurpose, dto.contractualPurpose);
  if (dto.vacantDate !== undefined) {
    const next = day(toDate(dto.vacantDate));
    if (day(before.vacantDate) !== next) {
      out.push(`Vacant date: ${day(before.vacantDate)} → ${next}`);
    }
  }
  if (dto.neededDate !== undefined) {
    const next = day(toDate(dto.neededDate));
    if (day(before.neededDate) !== next) {
      out.push(`When needed: ${day(before.neededDate)} → ${next}`);
    }
  }

  const prose = (
    label: string,
    was: string | null,
    next: string | undefined,
  ) => {
    if (next === undefined) return;
    const a = text(was);
    const b = text(next);
    if (a === b) return;
    out.push(
      !a
        ? `${label} added`
        : !b
          ? `${label} cleared`
          : `${label} rewritten (was ${a.length} characters)`,
    );
  };
  prose('Job description', before.jobDescription, dto.jobDescription);
  prose('Education & training', before.education, dto.education);
  prose('Experience', before.experience, dto.experience);
  prose('Others', before.others, dto.others);

  return out;
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
  /** Transport, full-time only: 'sedan' | 'suv'. */
  vehicleType?: string | null;
  /**
   * Transport: where the person is picked up from. No longer asked at
   * requisition time — nobody is selected yet, so nobody knows — but still
   * read here so requisitions raised before that change keep displaying it.
   */
  pickupLocation?: string | null;
  note: string;
  status: 'pending' | 'confirmed' | 'skipped';
  hrNote: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export const FACILITY_KEYS = [
  'laptopDesktop',
  'transport',
  'dormitory',
  'seating',
] as const;

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
      // Only transport sends this; the others carry null and cost nothing.
      vehicleType: input?.vehicleType ?? null,
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
