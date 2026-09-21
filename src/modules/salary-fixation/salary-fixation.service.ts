import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SalaryFixationStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { SettingsService, ScreeningConfig } from '../settings/settings.service';
import { DriveService } from '../integrations/google/drive.service';
import { RecruitmentService } from '../candidates/recruitment.service';
import { FileGrantService } from '../../common/files/file-grant.service';
import { lockedMarkConflicts, lockedMarkMessage } from './screening-lock';
import {
  bandFromScore,
  bandSalary,
  evaluateScreeningTest,
  isGradeVerified,
  isJobGrade,
  TOTAL_MAX,
} from './salary-fixation.constants';
import {
  UpsertSalaryFixationDto,
  UpsertScreeningTestsDto,
} from './dto/salary-fixation.dto';

export interface CommitteeScore {
  evaluatorId: string;
  evaluatorName: string;
  /** Which session this mark was given in — the UI groups on it. */
  roundId: string;
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
    private readonly drive: DriveService,
    private readonly recruitment: RecruitmentService,
    private readonly files: FileGrantService,
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
    return this.buildView(record, committee, screening, candidatePackageOf(cand));
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
        department: {
          name: { equals: requisition.department, mode: 'insensitive' },
        },
        unit: {
          name: { equals: requisition.unitFactory, mode: 'insensitive' },
        },
      },
      select: { grade: true },
    });
    if (position?.grade && isJobGrade(position.grade)) {
      return position.grade;
    }
    return null;
  }

  async upsert(
    candidateId: string,
    userId: string,
    dto: UpsertSalaryFixationDto,
  ) {
    const cand = await this.requireCandidate(candidateId, userId);
    const existing = await this.prisma.salaryFixation.findUnique({
      where: { candidateId: cand.id },
    });

    const merged = {
      jobGrade:
        dto.jobGrade !== undefined
          ? dto.jobGrade
          : (existing?.jobGrade ?? null),
      writtenTestEnabled:
        dto.writtenTestEnabled !== undefined
          ? dto.writtenTestEnabled
          : (existing?.writtenTestEnabled ?? false),
      writtenTestTotal:
        dto.writtenTestTotal !== undefined
          ? dto.writtenTestTotal
          : (existing?.writtenTestTotal ?? null),
      writtenTestObtained:
        dto.writtenTestObtained !== undefined
          ? dto.writtenTestObtained
          : (existing?.writtenTestObtained ?? null),
      computerTestEnabled:
        dto.computerTestEnabled !== undefined
          ? dto.computerTestEnabled
          : (existing?.computerTestEnabled ?? false),
      computerTestTotal:
        dto.computerTestTotal !== undefined
          ? dto.computerTestTotal
          : (existing?.computerTestTotal ?? null),
      computerTestObtained:
        dto.computerTestObtained !== undefined
          ? dto.computerTestObtained
          : (existing?.computerTestObtained ?? null),
      aiTestEnabled:
        dto.aiTestEnabled !== undefined
          ? dto.aiTestEnabled
          : (existing?.aiTestEnabled ?? true),
      aiTestTotal:
        dto.aiTestTotal !== undefined
          ? dto.aiTestTotal
          : (existing?.aiTestTotal ?? null),
      aiTestObtained:
        dto.aiTestObtained !== undefined
          ? dto.aiTestObtained
          : (existing?.aiTestObtained ?? null),
      bandOverride:
        dto.bandOverride !== undefined
          ? dto.bandOverride
          : (existing?.bandOverride ?? null),
      proposedSalaryOverride:
        dto.proposedSalaryOverride !== undefined
          ? dto.proposedSalaryOverride
          : (existing?.proposedSalaryOverride ?? null),
    };

    const saved = await this.prisma.salaryFixation.upsert({
      where: { candidateId: cand.id },
      create: {
        candidateId: cand.id,
        ...merged,
        status: SalaryFixationStatus.draft,
      },
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
    return this.buildView(saved, committee, screening, candidatePackageOf(cand));
  }

  async finalize(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const record = await this.prisma.salaryFixation.findUnique({
      where: { candidateId: cand.id },
    });
    if (!record) {
      throw new BadRequestException(
        'Start salary fixation for this candidate first.',
      );
    }
    const committee = await this.getCommitteeScores(cand.id);
    const screening = await this.settings.getScreeningConfig();
    const view = this.buildView(
      record,
      committee,
      screening,
      candidatePackageOf(cand),
    );

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

    return this.buildView(
      finalized,
      committee,
      screening,
      candidatePackageOf(cand),
    );
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
      throw new BadRequestException(
        'Start salary fixation for this candidate first.',
      );
    }
    const committee = await this.getCommitteeScores(cand.id);
    const screening = await this.settings.getScreeningConfig();
    const view = this.buildView(
      record,
      committee,
      screening,
      candidatePackageOf(cand),
    );

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

    return this.buildView(
      updated,
      committee,
      screening,
      candidatePackageOf(cand),
    );
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
  /**
   * Every mark this candidate was given, in every session.
   *
   * This used to keep only each evaluator's most recent evaluation, so a
   * panelist who sat on both the first and the second interview had their
   * first-round mark silently dropped — and a whole round could disappear
   * from the screen if the same three people ran it. HR could not see what
   * the first panel thought, and the average was computed from a set nobody
   * had chosen. Every row is returned now; the caller groups by round.
   */
  private async getCommitteeScores(
    candidateId: string,
  ): Promise<CommitteeScore[]> {
    const evaluations = await this.prisma.evaluation.findMany({
      where: { round: { candidateId } },
      include: {
        evaluator: { select: { name: true } },
        round: { select: { id: true, kind: true, scheduledAt: true } },
      },
      // Oldest session first, so the list reads first -> second -> final.
      orderBy: [{ round: { scheduledAt: 'asc' } }, { submittedAt: 'asc' }],
    });

    return evaluations.map((ev) => ({
      evaluatorId: ev.evaluatorId,
      evaluatorName: ev.evaluator.name,
      roundId: ev.round.id,
      roundKind: ev.round.kind.toLowerCase(),
      total: ev.total,
      max: TOTAL_MAX,
      submittedAt: ev.submittedAt.toISOString(),
    }));
  }

  /**
   * The committee average: each session averaged, then the sessions averaged.
   *
   * Not a flat mean over every evaluation. A first interview run by three
   * people and a final run by one are one session each — pooling the marks
   * would let the larger panel outvote the later, more senior one three to
   * one, which is not how the decision is actually made.
   */
  static averageAcrossRounds(committee: CommitteeScore[]): number | null {
    if (!committee.length) return null;
    const byRound = new Map<string, number[]>();
    for (const c of committee) {
      const list = byRound.get(c.roundId);
      if (list) list.push(c.total);
      else byRound.set(c.roundId, [c.total]);
    }
    const roundMeans = [...byRound.values()].map(
      (totals) => totals.reduce((a, b) => a + b, 0) / totals.length,
    );
    return roundMeans.reduce((a, b) => a + b, 0) / roundMeans.length;
  }

  /** Recompute screening status, average, band and proposed salary — never client-supplied. */
  private buildView(
    record: {
      jobGrade: string | null;
      writtenTestEnabled: boolean;
      writtenTestTotal: number | null;
      writtenTestObtained: number | null;
      writtenTestSheetId?: string | null;
      computerTestEnabled: boolean;
      computerTestTotal: number | null;
      computerTestObtained: number | null;
      computerTestSheetId?: string | null;
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
    /**
     * What the candidate told the interviewer, taken in the room.
     *
     * Shown beside our own figure so both sides of the negotiation are on
     * one screen: what they earn now, what they asked for, and what comes
     * with it. HR was otherwise opening the interview notes in another tab
     * to find out what they were bidding against.
     */
    candidatePackage: {
      presentSalary: number | null;
      salaryExpectation: number | null;
      salaryBenefitsNote: string | null;
      salaryBenefits: string[];
    },
  ) {
    const base = record ?? {
      jobGrade: null,
      writtenTestEnabled: false,
      writtenTestTotal: null,
      writtenTestObtained: null,
      computerTestEnabled: false,
      computerTestTotal: null,
      computerTestObtained: null,
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
    const computer = evaluateScreeningTest(
      base.computerTestTotal,
      base.computerTestObtained,
      base.computerTestEnabled,
      screening.computerTestPassPct,
    );
    const ai = evaluateScreeningTest(
      base.aiTestTotal,
      base.aiTestObtained,
      base.aiTestEnabled,
      screening.aiTestPassPct,
    );
    const failed =
      written.status === 'fail' ||
      computer.status === 'fail' ||
      ai.status === 'fail';

    let averageScore: number | null = null;
    let computedBand: number | null = null;
    let autoProposedSalary: number | null = null;

    // Compute from committee scores regardless of pass/fail — HR still needs
    // to see where a failed candidate would land (e.g. to weigh an override).
    // Finalizing is blocked separately below and in finalize() itself, so
    // this doesn't let a failed candidate slip through.
    if (committee.length > 0) {
      averageScore = SalaryFixationService.averageAcrossRounds(committee);
      computedBand = bandFromScore(Math.round(averageScore ?? 0));
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
      jobGradeVerified:
        base.jobGrade && isJobGrade(base.jobGrade)
          ? isGradeVerified(base.jobGrade)
          : null,
      writtenTestEnabled: base.writtenTestEnabled,
      writtenTestTotal: base.writtenTestTotal,
      writtenTestObtained: base.writtenTestObtained,
      writtenTestSheetUrl: this.sheetUrl(
        base.writtenTestSheetId,
        'Written Test',
      ),
      computerTestEnabled: base.computerTestEnabled,
      computerTestTotal: base.computerTestTotal,
      computerTestObtained: base.computerTestObtained,
      computerTestSheetUrl: this.sheetUrl(
        base.computerTestSheetId,
        'Computer Literacy',
      ),
      aiTestEnabled: base.aiTestEnabled,
      aiTestTotal: base.aiTestTotal,
      aiTestObtained: base.aiTestObtained,
      writtenTestPassPct: screening.writtenTestPassPct,
      computerTestPassPct: screening.computerTestPassPct,
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
      salaryExpectation: candidatePackage.salaryExpectation,
      /** What they are on today — the floor any offer has to clear. */
      presentSalary: candidatePackage.presentSalary,
      /** Allowances and perks they said their current package includes. */
      salaryBenefitsNote: candidatePackage.salaryBenefitsNote,
      /** The same, as ticked keys — lunch, pick and drop, housing, tax. */
      salaryBenefits: candidatePackage.salaryBenefits,
      status,
      offeredAt: base.offeredAt?.toISOString() ?? null,
      offeredById: base.offeredById,
      finalizedAt: base.finalizedAt?.toISOString() ?? null,
      finalizedById: base.finalizedById,
      createdAt: record?.createdAt?.toISOString() ?? null,
      updatedAt: record?.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Enter (or clear) the hand-marked screening tests for one candidate.
   *
   * Deliberately separate from `upsert`: whoever ran the first interview needs
   * to record Written and Computer Literacy marks, but salary fixation — band,
   * proposed figure, offer — is Head of Talent Acquisition's alone. This touches only the
   * six test columns and hands back only the screening picture, so a delegated
   * interviewer never sees a salary number.
   *
   * The AI Proficiency test is not settable here: it is scored by the system
   * from the candidate's own attempt, not typed in by hand.
   */
  async upsertScreeningTests(
    candidateId: string,
    userId: string,
    dto: UpsertScreeningTestsDto,
  ) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    const viaDelegation = await this.permissions.hasInterviewDelegation(
      userId,
      {
        candidateId,
      },
    );
    if (!viaDelegation) {
      await this.requireRecruitmentAccess(cand.requisition, userId);
    }

    const existing = await this.prisma.salaryFixation.findUnique({
      where: { candidateId },
    });

    // A delegate marks once. See screening-lock.ts for why — and note the
    // check is skipped for recruitment, who are the ones a correction goes
    // through.
    if (viaDelegation) {
      const locked = lockedMarkConflicts(existing, dto);
      if (locked.length) {
        throw new BadRequestException(lockedMarkMessage(locked));
      }
    }
    const pick = <T>(next: T | undefined, current: T, fallback: T): T =>
      next !== undefined ? next : (current ?? fallback);

    const data = {
      writtenTestEnabled: pick(
        dto.writtenTestEnabled,
        existing?.writtenTestEnabled,
        false,
      ),
      writtenTestTotal: pick(
        dto.writtenTestTotal,
        existing?.writtenTestTotal,
        null,
      ),
      writtenTestObtained: pick(
        dto.writtenTestObtained,
        existing?.writtenTestObtained,
        null,
      ),
      computerTestEnabled: pick(
        dto.computerTestEnabled,
        existing?.computerTestEnabled,
        false,
      ),
      computerTestTotal: pick(
        dto.computerTestTotal,
        existing?.computerTestTotal,
        null,
      ),
      computerTestObtained: pick(
        dto.computerTestObtained,
        existing?.computerTestObtained,
        null,
      ),
      aiTestEnabled: pick(dto.aiTestEnabled, existing?.aiTestEnabled, true),
    };

    const saved = await this.prisma.salaryFixation.upsert({
      where: { candidateId },
      create: { candidateId, ...data },
      update: data,
    });

    const screening = await this.settings.getScreeningConfig();
    return {
      candidateId,
      writtenTestEnabled: saved.writtenTestEnabled,
      writtenTestTotal: saved.writtenTestTotal,
      writtenTestObtained: saved.writtenTestObtained,
      writtenTestPassPct: screening.writtenTestPassPct,
      writtenTestSheetUrl: this.sheetUrl(
        saved.writtenTestSheetId,
        'Written Test',
      ),
      // Returned by the save as well as the read: the dialog updates its cache
      // from this response, so without it the inputs stay open until a refetch
      // and the delegate is invited to make an edit the server will refuse.
      writtenTestLocked: viaDelegation && saved.writtenTestObtained != null,
      computerTestEnabled: saved.computerTestEnabled,
      computerTestTotal: saved.computerTestTotal,
      computerTestObtained: saved.computerTestObtained,
      computerTestPassPct: screening.computerTestPassPct,
      computerTestSheetUrl: this.sheetUrl(
        saved.computerTestSheetId,
        'Computer Literacy',
      ),
      computerTestLocked: viaDelegation && saved.computerTestObtained != null,
      aiTestEnabled: saved.aiTestEnabled,
      aiTestTotal: saved.aiTestTotal,
      aiTestObtained: saved.aiTestObtained,
      aiTestPassPct: screening.aiTestPassPct,
    };
  }

  /**
   * The same screening picture, genuinely read-only.
   *
   * This used to call through to the upsert with an empty patch, which meant
   * merely opening the marks dialog created or touched a SalaryFixation row
   * and filed an audit entry — a read that writes. It now reads, and reports
   * the configured defaults when no row exists yet.
   */
  async getScreeningTests(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    const viaDelegation = await this.permissions.hasInterviewDelegation(
      userId,
      {
        candidateId,
      },
    );
    if (!viaDelegation) {
      await this.requireRecruitmentAccess(cand.requisition, userId);
    }

    const saved = await this.prisma.salaryFixation.findUnique({
      where: { candidateId },
    });
    const screening = await this.settings.getScreeningConfig();
    return {
      candidateId,
      writtenTestEnabled: saved?.writtenTestEnabled ?? false,
      writtenTestTotal: saved?.writtenTestTotal ?? null,
      writtenTestObtained: saved?.writtenTestObtained ?? null,
      writtenTestPassPct: screening.writtenTestPassPct,
      writtenTestSheetUrl: this.sheetUrl(
        saved?.writtenTestSheetId,
        'Written Test',
      ),
      /** True when this reader may no longer change the mark — see screening-lock.ts. */
      writtenTestLocked: viaDelegation && saved?.writtenTestObtained != null,
      computerTestEnabled: saved?.computerTestEnabled ?? false,
      computerTestTotal: saved?.computerTestTotal ?? null,
      computerTestObtained: saved?.computerTestObtained ?? null,
      computerTestPassPct: screening.computerTestPassPct,
      computerTestSheetUrl: this.sheetUrl(
        saved?.computerTestSheetId,
        'Computer Literacy',
      ),
      computerTestLocked: viaDelegation && saved?.computerTestObtained != null,
      aiTestEnabled: saved?.aiTestEnabled ?? true,
      aiTestTotal: saved?.aiTestTotal ?? null,
      aiTestObtained: saved?.aiTestObtained ?? null,
      aiTestPassPct: screening.aiTestPassPct,
    };
  }

  /**
   * Attach the marked answer script to a hand-marked screening test.
   *
   * Optional, and deliberately so: these tests were always markable without
   * one, and a factory interviewer with no scanner must not be blocked from
   * recording a mark. When it is attached, Corporate HR and the recruiter can
   * open it beside the mark rather than taking the number on trust.
   *
   * Filed in the requisition's own "03 Interview Docs" folder, because that is
   * where the rest of the interview paperwork for this post lives.
   */
  async uploadTestSheet(
    candidateId: string,
    userId: string,
    kind: 'written' | 'computer',
    file?: { buffer: Buffer; mimetype: string; originalname: string },
  ) {
    if (!file) throw new BadRequestException('Please attach the exam sheet');
    const cand = await this.requireScreeningAccess(candidateId, userId);

    const ws = await this.recruitment.ensureWorkspace(cand.requisition);
    if (!ws) {
      throw new ServiceUnavailableException(
        'Document storage is unavailable just now. Please try again in a moment.',
      );
    }
    const label = kind === 'written' ? 'Written Test' : 'Computer Literacy';
    const folder = await this.drive.ensureFolder(
      `${cand.name} — Test Sheets`,
      ws.interviewFolderId,
    );
    const uploaded = await this.drive.uploadFile(folder, {
      name: `${label} — ${cand.name}.pdf`,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });

    await this.prisma.salaryFixation.upsert({
      where: { candidateId },
      create: {
        candidateId,
        ...(kind === 'written'
          ? {
              writtenTestSheetId: uploaded.id,
              writtenTestSheetUrl: uploaded.url,
            }
          : {
              computerTestSheetId: uploaded.id,
              computerTestSheetUrl: uploaded.url,
            }),
      },
      update:
        kind === 'written'
          ? {
              writtenTestSheetId: uploaded.id,
              writtenTestSheetUrl: uploaded.url,
            }
          : {
              computerTestSheetId: uploaded.id,
              computerTestSheetUrl: uploaded.url,
            },
    });

    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'test_sheet',
    });
    return this.getScreeningTests(candidateId, userId);
  }

  /**
   * Detach it — the wrong file, or the wrong candidate's script.
   *
   * The file itself stays on Drive: deleting someone's marked paper because a
   * link was wrong is not a decision this button should be able to make.
   */
  async removeTestSheet(
    candidateId: string,
    userId: string,
    kind: 'written' | 'computer',
  ) {
    await this.requireScreeningAccess(candidateId, userId);
    await this.prisma.salaryFixation.update({
      where: { candidateId },
      data:
        kind === 'written'
          ? { writtenTestSheetId: null, writtenTestSheetUrl: null }
          : { computerTestSheetId: null, computerTestSheetUrl: null },
    });
    return this.getScreeningTests(candidateId, userId);
  }

  /**
   * Served through a signed grant, never the Drive link.
   *
   * The interview folder is private to the recruitment account, so a Drive URL
   * would show everyone else Google's request-access screen for a document
   * they are entitled to read.
   */
  private sheetUrl(fileId: string | null | undefined, label: string) {
    return this.files.url(fileId, 'exam-sheet', { filename: label }) ?? null;
  }

  /** Whoever may mark the test may attach its script: the delegate, or recruitment. */
  private async requireScreeningAccess(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    if (
      !(await this.permissions.hasInterviewDelegation(userId, { candidateId }))
    ) {
      await this.requireRecruitmentAccess(cand.requisition, userId);
    }
    return cand;
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

  /** Salary fixation is a recruitment action — Head of Talent Acquisition / CHRO / super only. */
  /**
   * Post-approval work is Head of Talent Acquisition / CHRO / super — plus the Corporate
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

/**
 * The candidate's own salary story, as one object.
 *
 * Pulled out so every call site passes the same fields — they were a
 * single loose `salaryExpectation` argument before, and adding the other two
 * inline at six call sites is how one of them ends up out of step.
 */
function candidatePackageOf(cand: {
  presentSalary: number | null;
  salaryExpectation: number | null;
  salaryBenefitsNote: string | null;
  salaryBenefits: string[];
}) {
  return {
    presentSalary: cand.presentSalary,
    salaryExpectation: cand.salaryExpectation,
    salaryBenefitsNote: cand.salaryBenefitsNote,
    salaryBenefits: cand.salaryBenefits,
  };
}
