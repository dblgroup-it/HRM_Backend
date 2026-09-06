import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SalaryFixationStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { SettingsService, ScreeningConfig } from '../settings/settings.service';
import {
  bandFromScore,
  bandSalary,
  evaluateScreeningTest,
  isGradeVerified,
  isJobGrade,
  TOTAL_MAX,
} from './salary-fixation.constants';
import { UpsertSalaryFixationDto } from './dto/salary-fixation.dto';

export interface CommitteeScore {
  evaluatorId: string;
  evaluatorName: string;
  roundKind: string;
  total: number;
  max: number;
  submittedAt: string;
}

@Injectable()
export class SalaryFixationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  async get(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    let record = await this.prisma.salaryFixation.findUnique({
      where: { candidateId: cand.id },
    });
    // Default the job grade the first time anyone opens Salary Fixation for
    // this candidate — never overwrites a grade HR already set.
    if (!record?.jobGrade) {
      const grade = await this.resolveRequisitionGrade(cand.requisition);
      if (grade) {
        await this.presetJobGrade(cand.id, grade);
        record = await this.prisma.salaryFixation.findUnique({
          where: { candidateId: cand.id },
        });
      }
    }
    const committee = await this.getCommitteeScores(cand.id);
    const screening = await this.settings.getScreeningConfig();
    return this.buildView(record, committee, screening, cand.salaryExpectation);
  }

  /**
   * The requisition's own `grade` (set by the approver during sign-off) is
   * the confirmed source, but is almost never actually filled in in
   * practice. Fall back to the organogram seat's grade for this exact
   * unit/department/designation — the same lookup the requisition form
   * itself shows as "Organogram grade" when the post was raised.
   */
  private async resolveRequisitionGrade(requisition: {
    grade: string | null;
    unitFactory: string;
    department: string;
    designation: string;
  }): Promise<string | null> {
    if (requisition.grade && isJobGrade(requisition.grade)) {
      return requisition.grade;
    }
    const position = await this.prisma.position.findFirst({
      where: {
        designation: { equals: requisition.designation, mode: 'insensitive' },
        department: { name: { equals: requisition.department, mode: 'insensitive' } },
        unit: { name: { equals: requisition.unitFactory, mode: 'insensitive' } },
      },
      select: { grade: true },
    });
    if (position?.grade && isJobGrade(position.grade)) {
      return position.grade;
    }
    return null;
  }

  async upsert(candidateId: string, userId: string, dto: UpsertSalaryFixationDto) {
    const cand = await this.requireCandidate(candidateId, userId);
    const existing = await this.prisma.salaryFixation.findUnique({
      where: { candidateId: cand.id },
    });

    const merged = {
      jobGrade: dto.jobGrade !== undefined ? dto.jobGrade : (existing?.jobGrade ?? null),
      writtenTestEnabled:
        dto.writtenTestEnabled !== undefined
          ? dto.writtenTestEnabled
          : (existing?.writtenTestEnabled ?? false),
      writtenTestTotal:
        dto.writtenTestTotal !== undefined ? dto.writtenTestTotal : (existing?.writtenTestTotal ?? null),
      writtenTestObtained:
        dto.writtenTestObtained !== undefined
          ? dto.writtenTestObtained
          : (existing?.writtenTestObtained ?? null),
      aiTestEnabled:
        dto.aiTestEnabled !== undefined ? dto.aiTestEnabled : (existing?.aiTestEnabled ?? true),
      aiTestTotal: dto.aiTestTotal !== undefined ? dto.aiTestTotal : (existing?.aiTestTotal ?? null),
      aiTestObtained:
        dto.aiTestObtained !== undefined ? dto.aiTestObtained : (existing?.aiTestObtained ?? null),
      bandOverride:
        dto.bandOverride !== undefined ? dto.bandOverride : (existing?.bandOverride ?? null),
      proposedSalaryOverride:
        dto.proposedSalaryOverride !== undefined
          ? dto.proposedSalaryOverride
          : (existing?.proposedSalaryOverride ?? null),
    };

    const saved = await this.prisma.salaryFixation.upsert({
      where: { candidateId: cand.id },
      create: { candidateId: cand.id, ...merged, status: SalaryFixationStatus.draft },
      update: {
        ...merged,
        // Any edit after finalization reopens the record for correction.
        status: SalaryFixationStatus.draft,
        finalizedAt: null,
        finalizedById: null,
      },
    });

    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'salary_fixation_updated',
    });

    const committee = await this.getCommitteeScores(cand.id);
    const screening = await this.settings.getScreeningConfig();
    return this.buildView(saved, committee, screening, cand.salaryExpectation);
  }

  async finalize(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const record = await this.prisma.salaryFixation.findUnique({
      where: { candidateId: cand.id },
    });
    if (!record) {
      throw new BadRequestException('Start salary fixation for this candidate first.');
    }
    const committee = await this.getCommitteeScores(cand.id);
    const screening = await this.settings.getScreeningConfig();
    const view = this.buildView(record, committee, screening, cand.salaryExpectation);

    if (view.status === SalaryFixationStatus.screening_failed) {
      throw new BadRequestException(
        'This candidate did not clear screening — salary fixation cannot be finalized.',
      );
    }
    if (view.proposedSalary == null) {
      throw new BadRequestException(
        'At least one interviewer must submit salary scores, and a job grade must be selected, before finalizing.',
      );
    }

    const finalized = await this.prisma.salaryFixation.update({
      where: { candidateId: cand.id },
      data: {
        averageScore: view.averageScore,
        computedBand: view.computedBand,
        proposedSalary: view.proposedSalary,
        status: SalaryFixationStatus.fixed,
        finalizedAt: new Date(),
        finalizedById: userId,
      },
    });

    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'salary_fixation_finalized',
    });

    return this.buildView(finalized, committee, screening, cand.salaryExpectation);
  }

  /**
   * Record that a figure was formally communicated to the candidate —
   * lighter-weight than finalize(): only needs a proposed salary to exist,
   * not full committee scoring or a passed screening. Reversible by editing
   * the form again (mirrors finalize()'s own "any edit reopens" behaviour).
   */
  async markOffered(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const record = await this.prisma.salaryFixation.findUnique({
      where: { candidateId: cand.id },
    });
    if (!record) {
      throw new BadRequestException('Start salary fixation for this candidate first.');
    }
    const committee = await this.getCommitteeScores(cand.id);
    const screening = await this.settings.getScreeningConfig();
    const view = this.buildView(record, committee, screening, cand.salaryExpectation);

    if (view.proposedSalary == null) {
      throw new BadRequestException(
        'Enter a proposed gross salary before marking it as offered.',
      );
    }

    const updated = await this.prisma.salaryFixation.update({
      where: { candidateId: cand.id },
      data: { offeredAt: new Date(), offeredById: userId },
    });

    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'salary_fixation_offered',
    });

    return this.buildView(updated, committee, screening, cand.salaryExpectation);
  }

  /**
   * Preset the job grade at AI Proficiency Test assignment time — the first
   * point in the pipeline a grade is known, well before actual fixation.
   * System-invoked (from AiProficiencyService, itself HR-authenticated at
   * that call site), not gated by requireRecruitmentAccess again here.
   */
  async presetJobGrade(candidateId: string, jobGrade: string): Promise<void> {
    await this.prisma.salaryFixation.upsert({
      where: { candidateId },
      create: { candidateId, jobGrade },
      update: { jobGrade },
    });
  }

  /**
   * Record an AI Proficiency Test result once a candidate submits — called
   * from AiProficiencyService's public (no-login) submit endpoint, so this
   * bypasses the HR-authenticated upsert() path deliberately.
   */
  async recordAiProficiencyResult(
    candidateId: string,
    result: { maxScore: number; totalScore: number },
  ): Promise<void> {
    await this.prisma.salaryFixation.upsert({
      where: { candidateId },
      create: {
        candidateId,
        aiTestTotal: result.maxScore,
        aiTestObtained: result.totalScore,
      },
      update: {
        aiTestTotal: result.maxScore,
        aiTestObtained: result.totalScore,
      },
    });
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { requisitionId: true },
    });
    if (cand) {
      this.notifications.broadcastChange('candidate', cand.requisitionId, {
        action: 'ai_proficiency_submitted',
      });
    }
  }

  /** Every distinct evaluator (across all of the candidate's interview rounds)
   * who submitted their evaluation — every submission scores the same fixed
   * criteria, so it counts toward salary fixation automatically. */
  private async getCommitteeScores(candidateId: string): Promise<CommitteeScore[]> {
    const evaluations = await this.prisma.evaluation.findMany({
      where: { round: { candidateId } },
      include: { evaluator: { select: { name: true } }, round: { select: { kind: true } } },
      orderBy: { submittedAt: 'desc' },
    });

    const byEvaluator = new Map<string, CommitteeScore>();
    for (const ev of evaluations) {
      // Rows are ordered newest-first — the first one seen per evaluator wins.
      if (byEvaluator.has(ev.evaluatorId)) continue;
      byEvaluator.set(ev.evaluatorId, {
        evaluatorId: ev.evaluatorId,
        evaluatorName: ev.evaluator.name,
        roundKind: ev.round.kind.toLowerCase(),
        total: ev.total,
        max: TOTAL_MAX,
        submittedAt: ev.submittedAt.toISOString(),
      });
    }
    return [...byEvaluator.values()];
  }

  /** Recompute screening status, average, band and proposed salary — never client-supplied. */
  private buildView(
    record: {
      jobGrade: string | null;
      writtenTestEnabled: boolean;
      writtenTestTotal: number | null;
      writtenTestObtained: number | null;
      aiTestEnabled: boolean;
      aiTestTotal: number | null;
      aiTestObtained: number | null;
      bandOverride: number | null;
      proposedSalaryOverride: number | null;
      status: SalaryFixationStatus;
      offeredAt: Date | null;
      offeredById: string | null;
      finalizedAt: Date | null;
      finalizedById: string | null;
      id?: string;
      candidateId?: string;
      createdAt?: Date;
      updatedAt?: Date;
    } | null,
    committee: CommitteeScore[],
    screening: ScreeningConfig,
    salaryExpectation: number | null,
  ) {
    const base = record ?? {
      jobGrade: null,
      writtenTestEnabled: false,
      writtenTestTotal: null,
      writtenTestObtained: null,
      aiTestEnabled: true,
      aiTestTotal: null,
      aiTestObtained: null,
      bandOverride: null,
      proposedSalaryOverride: null,
      status: SalaryFixationStatus.draft,
      offeredAt: null,
      offeredById: null,
      finalizedAt: null,
      finalizedById: null,
    };

    const written = evaluateScreeningTest(
      base.writtenTestTotal,
      base.writtenTestObtained,
      base.writtenTestEnabled,
      screening.writtenTestPassPct,
    );
    const ai = evaluateScreeningTest(
      base.aiTestTotal,
      base.aiTestObtained,
      base.aiTestEnabled,
      screening.aiTestPassPct,
    );
    const failed = written.status === 'fail' || ai.status === 'fail';

    let averageScore: number | null = null;
    let computedBand: number | null = null;
    let autoProposedSalary: number | null = null;

    // Compute from committee scores regardless of pass/fail — HR still needs
    // to see where a failed candidate would land (e.g. to weigh an override).
    // Finalizing is blocked separately below and in finalize() itself, so
    // this doesn't let a failed candidate slip through.
    if (committee.length > 0) {
      averageScore = committee.reduce((sum, c) => sum + c.total, 0) / committee.length;
      computedBand = bandFromScore(Math.round(averageScore));
      const effectiveBand = base.bandOverride ?? computedBand;
      if (base.jobGrade && isJobGrade(base.jobGrade)) {
        autoProposedSalary = bandSalary(base.jobGrade, effectiveBand);
      }
    }
    // HR's manual figure always wins when set — independent of committee
    // scores being in yet, per policy's "Management reserves the right to
    // deviation" (same rationale as bandOverride).
    const proposedSalary = base.proposedSalaryOverride ?? autoProposedSalary;

    const status: SalaryFixationStatus =
      base.status === SalaryFixationStatus.fixed
        ? SalaryFixationStatus.fixed
        : failed
          ? SalaryFixationStatus.screening_failed
          : SalaryFixationStatus.draft;

    return {
      id: record?.id ?? null,
      candidateId: record?.candidateId ?? null,
      jobGrade: base.jobGrade,
      jobGradeVerified: base.jobGrade && isJobGrade(base.jobGrade) ? isGradeVerified(base.jobGrade) : null,
      writtenTestEnabled: base.writtenTestEnabled,
      writtenTestTotal: base.writtenTestTotal,
      writtenTestObtained: base.writtenTestObtained,
      aiTestEnabled: base.aiTestEnabled,
      aiTestTotal: base.aiTestTotal,
      aiTestObtained: base.aiTestObtained,
      writtenTestPassPct: screening.writtenTestPassPct,
      aiTestPassPct: screening.aiTestPassPct,
      interviewers: committee,
      averageScore,
      evaluationMax: TOTAL_MAX,
      computedBand,
      bandOverride: base.bandOverride,
      proposedSalary,
      proposedSalaryOverride: base.proposedSalaryOverride,
      /** What the candidate asked for — separate from our proposed figure,
       * so both sides of the negotiation are visible side by side. */
      salaryExpectation,
      status,
      offeredAt: base.offeredAt?.toISOString() ?? null,
      offeredById: base.offeredById,
      finalizedAt: base.finalizedAt?.toISOString() ?? null,
      finalizedById: base.finalizedById,
      createdAt: record?.createdAt?.toISOString() ?? null,
      updatedAt: record?.updatedAt?.toISOString() ?? null,
    };
  }

  private async requireCandidate(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);
    return cand;
  }

  /** Salary fixation is a recruitment action — Corporate HR / CHRO / super only. */
  /**
   * Post-approval work is Corporate HR / CHRO / super — plus the Corporate
   * Recruiter assigned to this requisition. Takes the requisition (not just
   * its unit) so the assigned recruiter is always considered.
   */
  private async requireRecruitmentAccess(
    req: { unitFactory: string; recruiterId: string | null },
    userId: string,
  ) {
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      'manage salary fixation',
    );
  }
}
