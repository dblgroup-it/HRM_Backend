import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CandidateStage, Prisma } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import * as ExcelJS from 'exceljs';

import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PermissionsService,
  type RecruitmentSubject,
} from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { DriveService } from '../integrations/google/drive.service';
import { MailService } from '../integrations/mail/mail.service';
import {
  AiGraderService,
  type ScreenResult,
  type ScreenRole,
} from '../integrations/ai/ai-grader.service';
import { SettingsService } from '../settings/settings.service';
import {
  firstInterviewHold,
  type HoldDelegationRow,
} from '../assessment/first-interview-hold';
import type { RequisitionDriveMap } from '../integrations/google/google.types';
import { RecruitmentService } from './recruitment.service';
import { FileGrantService } from '../../common/files/file-grant.service';
import { SecureFileService } from '../../common/files/secure-file.service';
import type { CvProfile } from './cv/cv-profile.types';
import { buildCvDocument } from './cv/cv-document';
import { photoDataUri } from './cv/candidate-photo';
import { cvProfileToText } from './cv/cv-text';
import { extractedCvToProfile } from './cv/cv-extract';
import { pushIf, sortTimeline, type TimelineEvent } from './candidate-timeline';
import { bulkCandidateNames } from './bulk-cv';
import { applyCounts, emailKey, phoneKey, sameApplicant } from './apply-identity';
import { normalizeGender } from './gender';
import { cvHeadline } from './cv/cv-headline';
import { CV_SOURCE_LABEL } from '../requisition/cv-sources';
import {
  applicationsCloseAt,
  applicationsOpen,
  lastDayToApply,
} from './application-window';
import {
  BulkCreateCandidatesDto,
  BulkRejectDto,
  CandidateQueryDto,
  CreateCandidateDto,
  EmailCandidateDto,
  PublicApplyDto,
  UpdateCandidateDto,
} from './dto/candidate.dto';
import { SandboxService } from '../sandbox/sandbox.service';
import { renderPlainMessage } from '../integrations/mail/branded-email';
import { designationLabel } from '../requisition/requisition-inputs';
import { CandidateMailService } from './candidate-mail.service';
import { applicationId, applicationNoFromSearch } from './reference-ids';
import { dueReferralsWhere, openReferralWhere } from './referral-window';

/** The subset of a Multer file we use (typed locally to avoid extra deps). */
export interface UploadedCv {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** An employee referring a candidate, snapshotted as they are at the time. */
interface Referrer {
  code: string;
  name: string;
  designation: string | null;
}

type CandidateRow = Prisma.CandidateGetPayload<object> & {
  /** Present only where the query includes it; the name of whoever rejected. */
  rejectedBy?: { name: string } | null;
  /** Present only where the query includes it; who sent the regret mail. */
  regretSentBy?: { name: string } | null;
  /**
   * Present only where the query includes it; open first-interview hand-offs,
   * which decide whether the recruiter's Interviews tab may act on the round
   * or must leave it with the delegate — see `firstInterviewHold`.
   */
  interviewDelegations?: HoldDelegationRow[] | null;
  /** Present only where the query includes it; rounds that were held. */
  interviews?: { kind: string }[] | null;
  /** Present only where the query includes it; who added the candidate. */
  createdBy?: { name: string } | null;
  /** Present only where the query includes it; the Factory HR Head sign-off. */
  firstInterviewApproval?: {
    status: string;
    decisionNote: string | null;
    decidedBy: { name: string } | null;
  } | null;
};

interface ScreeningJob {
  done: number;
  total: number;
  shortlisted: number;
  active: boolean;
}

/** How long before a CV read that found nothing is tried again. */
const CV_READ_RETRY_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class CandidatesService {
  private readonly screeningJobs = new Map<string, ScreeningJob>();
  private readonly logger = new Logger(CandidatesService.name);

  constructor(
    private readonly sandbox: SandboxService,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly drive: DriveService,
    private readonly mail: MailService,
    private readonly ai: AiGraderService,
    private readonly settings: SettingsService,
    private readonly recruitment: RecruitmentService,
    private readonly files: FileGrantService,
    private readonly secureFiles: SecureFileService,
    private readonly candidateMail: CandidateMailService,
  ) {}

  // --- workspace -----------------------------------------------------------

  async getWorkspace(reqId: string, userId: string) {
    const req = await this.requireReq(reqId, userId);
    return {
      connected: this.recruitment.driveConnected(),
      mailConfigured: this.mail.isConfigured(),
      aiScreening: this.ai.isConfigured(),
      drive: (req.drive as unknown as RequisitionDriveMap | null) ?? null,
    };
  }

  async setupWorkspace(reqId: string, userId: string) {
    const req = await this.requireReq(reqId, userId);
    const drive = await this.recruitment.ensureWorkspace(req);
    if (!drive) {
      throw new ServiceUnavailableException(
        'Google Drive is not connected. Complete the Drive setup first.',
      );
    }
    // Safety: ensure the CV folder is private (revoke any legacy public sharing).
    try {
      await this.drive.revokeAnyoneAccess(drive.allCvFolderId);
    } catch {
      /* best effort — folder may already be private */
    }
    return { connected: true, drive };
  }

  // --- candidates ----------------------------------------------------------

  async list(reqId: string, userId: string, query: CandidateQueryDto = {}) {
    await this.requireReq(reqId, userId);

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

    const where: Prisma.CandidateWhereInput = {
      requisitionId: reqId,
      deletedAt: null,
    };
    if (query.stage) where.stage = query.stage.toUpperCase() as CandidateStage;
    if (query.minScore != null) where.matchScore = { gte: query.minScore };
    if (query.search?.trim()) {
      const term = query.search.trim();
      // A candidate quoting their Application ID (APP-2026-00031) is found by it.
      const applicationNo = applicationNoFromSearch(term);
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
        ...(applicationNo ? [{ applicationNo }] : []),
      ];
    }

    const orderBy: Prisma.CandidateOrderByWithRelationInput =
      query.sortBy === 'name'
        ? { name: 'asc' }
        : query.sortBy === 'recent'
          ? { createdAt: 'desc' }
          : { matchScore: { sort: 'desc', nulls: 'last' } }; // default: match

    const [rows, total] = await Promise.all([
      this.prisma.candidate.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          onboarding: { select: { status: true } },
          // So the row can say who turned them down, not just that it happened.
          rejectedBy: { select: { name: true } },
          regretSentBy: { select: { name: true } },
          // "Added by … (Factory HR)" on the row.
          createdBy: { select: { name: true } },
          // Whose first interview this is. The Interviews tab lists everyone
          // at the Interview stage, and a candidate only reaches that stage
          // because somebody scheduled their first round — often the factory
          // colleague it was handed to. Without this the tab cannot tell the
          // two apart, and offers the recruiter controls over a round that is
          // not theirs to run.
          // Completed hand-offs too: they say the factory ran the first
          // round, which stays theirs even after the verdict.
          interviewDelegations: {
            where: { revokedAt: null },
            select: {
              revokedAt: true,
              completedAt: true,
              delegatedTo: { select: { id: true, name: true } },
            },
          },
          firstInterviewApproval: {
            select: {
              status: true,
              decisionNote: true,
              decidedBy: { select: { name: true } },
            },
          },
          // Which rounds are behind them, so "schedule all at once" can
          // suggest the next one instead of always offering a first.
          interviews: {
            where: { status: 'COMPLETED' },
            select: { kind: true },
          },
        },
      }),
      this.prisma.candidate.count({ where }),
    ]);

    // Stats across ALL candidates for this requisition (ignores current filter).
    const baseWhere = { requisitionId: reqId, deletedAt: null };
    const [s90, s75, s50, s25, unscreened, notViewed, finalists, stageCounts] =
      await Promise.all([
        this.prisma.candidate.count({
          where: { ...baseWhere, matchScore: { gte: 90 } },
        }),
        this.prisma.candidate.count({
          where: { ...baseWhere, matchScore: { gte: 75, lt: 90 } },
        }),
        this.prisma.candidate.count({
          where: { ...baseWhere, matchScore: { gte: 50, lt: 75 } },
        }),
        this.prisma.candidate.count({
          where: { ...baseWhere, matchScore: { gte: 25, lt: 50 } },
        }),
        this.prisma.candidate.count({
          where: { ...baseWhere, screenedAt: null },
        }),
        this.prisma.candidate.count({
          where: { ...baseWhere, viewedAt: null },
        }),
        this.prisma.candidate.count({
          where: {
            ...baseWhere,
            stage: { in: ['INTERVIEW', 'FINAL', 'SELECTED'] },
          },
        }),
        this.prisma.candidate.groupBy({
          by: ['stage'],
          where: baseWhere,
          _count: { id: true },
        }),
      ]);

    const totalAll = stageCounts.reduce((s, r) => s + r._count.id, 0);
    const stageCountMap: Record<string, number> = { all: totalAll };
    for (const r of stageCounts) {
      stageCountMap[r.stage.toLowerCase()] = r._count.id;
    }

    // applyCount: how many times each person has applied across ALL
    // requisitions — same email or same mobile (see apply-identity.ts).
    const countMap = applyCounts(rows, await this.sameApplicantPool(rows));

    // A row still missing its male / female indicator gets one background
    // read (or inherits it from the same person's other application).
    for (const r of rows) {
      if (!r.gender && r.cvFileId && !this.genderTried.has(r.id)) {
        this.genderTried.add(r.id);
        this.queueCvRead(r.id, r.requisitionId);
      }
    }

    // Finalized salary fixation result, shown as a badge on the candidate row.
    const rowIds = rows.map((r) => r.id);
    const fixations =
      rowIds.length > 0
        ? await this.prisma.salaryFixation.findMany({
            where: { candidateId: { in: rowIds }, status: 'fixed' },
            select: { candidateId: true, proposedSalary: true, jobGrade: true },
          })
        : [];
    const fixationMap = new Map(fixations.map((f) => [f.candidateId, f]));

    return {
      items: rows.map((r) => ({
        ...serializeCandidate(r, this.files),
        applyCount: countMap.get(r.id) ?? 1,
        proposedSalary: fixationMap.get(r.id)?.proposedSalary ?? null,
        salaryJobGrade: fixationMap.get(r.id)?.jobGrade ?? null,
        onboardingStatus: r.onboarding?.status ?? null,
      })),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
      stats: {
        total: totalAll,
        notViewed,
        finalists,
        stageCounts: stageCountMap,
        band90: s90,
        band75: s75,
        band50: s50,
        band25: s25,
        unscreened,
      },
    };
  }

  /**
   * Progress of the background AI screening run for a requisition.
   *
   * Gated like every other read on this requisition — the counters say how
   * many CVs it has and how many the AI shortlisted, which is not something
   * an unrelated signed-in user should be able to poll for any requisition id.
   */
  async getScreeningStatus(
    reqId: string,
    userId: string,
  ): Promise<{
    done: number;
    total: number;
    shortlisted: number;
    active: boolean;
  }> {
    await this.requireReq(reqId, userId);
    return (
      this.screeningJobs.get(reqId) ?? {
        done: 0,
        total: 0,
        shortlisted: 0,
        active: false,
      }
    );
  }

  async exportCandidates(
    reqId: string,
    userId: string,
    query: CandidateQueryDto = {},
  ) {
    const req = await this.requireReq(reqId, userId);

    const where: Prisma.CandidateWhereInput = {
      requisitionId: reqId,
      deletedAt: null,
    };
    if (query.stage) where.stage = query.stage.toUpperCase() as CandidateStage;
    if (query.minScore != null) where.matchScore = { gte: query.minScore };
    if (query.search?.trim()) {
      const term = query.search.trim();
      // A candidate quoting their Application ID (APP-2026-00031) is found by it.
      const applicationNo = applicationNoFromSearch(term);
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
        ...(applicationNo ? [{ applicationNo }] : []),
      ];
    }

    const orderBy: Prisma.CandidateOrderByWithRelationInput =
      query.sortBy === 'name'
        ? { name: 'asc' }
        : query.sortBy === 'recent'
          ? { createdAt: 'desc' }
          : { matchScore: { sort: 'desc', nulls: 'last' } };

    const rows = await this.prisma.candidate.findMany({ where, orderBy });

    const STAGE_LABEL: Record<string, string> = {
      APPLIED: 'Applied',
      AI_SHORTLISTED: 'AI Shortlisted',
      SHORTLISTED: 'Shortlisted',
      INTERVIEW: 'Interview',
      FINAL: 'Final',
      SELECTED: 'Selected',
      REJECTED: 'Rejected',
    };

    // Stage fill colors for Excel cells
    const STAGE_COLOR: Record<string, string> = {
      APPLIED: 'FFE2E8F0',
      AI_SHORTLISTED: 'FFEDE9FE',
      SHORTLISTED: 'FFE0F2FE',
      INTERVIEW: 'FFFEF3C7',
      FINAL: 'FFE0E7FF',
      SELECTED: 'FFD1FAE5',
      REJECTED: 'FFFEE2E2',
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'DBL HRM';
    wb.created = new Date();

    const ws = wb.addWorksheet('Candidates', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    // Column definitions
    ws.columns = [
      { header: '#', key: 'no', width: 5 },
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 16 },
      { header: 'AI Match Score', key: 'score', width: 16 },
      { header: 'Stage', key: 'stage', width: 16 },
      { header: 'Applied Date', key: 'applied', width: 14 },
      { header: 'Source', key: 'source', width: 12 },
      { header: 'Notes', key: 'notes', width: 40 },
    ];

    // Style header row
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1877C0' },
      };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF0F5999' } } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    headerRow.height = 22;

    // Data rows
    rows.forEach((r, idx) => {
      const score = r.matchScore != null ? r.matchScore : null;
      const stageFill = STAGE_COLOR[r.stage] ?? 'FFFFFFFF';

      const row = ws.addRow({
        no: idx + 1,
        name: r.name ?? '',
        email: r.email ?? '',
        phone: r.phone ?? '',
        score: score,
        stage: STAGE_LABEL[r.stage] ?? r.stage,
        applied: r.createdAt.toISOString().slice(0, 10),
        source: r.source ?? '',
        notes: r.notes ?? '',
      });

      row.height = 18;

      // Alternate row background
      const rowBg = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC';

      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.alignment = { vertical: 'middle', wrapText: false };
        cell.font = { size: 10 };

        if (colNum === 6) {
          // Stage column — colored fill
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: stageFill },
          };
          cell.font = { size: 10, bold: true };
        } else if (colNum === 5 && score != null) {
          // Score column — green if ≥75, amber if ≥50, red otherwise
          const scoreBg =
            score >= 75 ? 'FFD1FAE5' : score >= 50 ? 'FFFEF3C7' : 'FFFEE2E2';
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: scoreBg },
          };
          cell.font = { size: 10, bold: true };
          cell.numFmt = '0"%"'; // show as number (score is 0-100)
        } else {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: rowBg },
          };
        }
      });
    });

    // Auto-filter on header row
    ws.autoFilter = { from: 'A1', to: `I1` };

    const buffer = await wb.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    const filename = `candidates-${req.code ?? reqId}-${date}.xlsx`;

    return { buffer: Buffer.from(buffer), filename };
  }

  async bulkReject(reqId: string, userId: string, dto: BulkRejectDto) {
    await this.requireReq(reqId, userId);
    const where = {
      requisitionId: reqId,
      stage: { in: ['APPLIED', 'AI_SHORTLISTED'] as CandidateStage[] },
      matchScore: { lte: dto.maxScore },
    };
    // Read first, so the page can offer the regret mail to exactly the people
    // this turned down — not everyone who was ever rejected on the post.
    const targets = await this.prisma.candidate.findMany({
      where,
      select: { id: true },
    });
    const ids = targets.map((t) => t.id);
    const result = await this.prisma.candidate.updateMany({
      where: { id: { in: ids }, ...where },
      data: { stage: 'REJECTED' },
    });
    this.notifications.broadcastChange('candidate', reqId, {
      action: 'bulk_rejected',
    });
    return { rejected: result.count, ids };
  }

  /**
   * The candidate's CV in the system's common format.
   *
   * `profile` is present when the source sent structured data (Bdjobs today);
   * `url` when there is a document. A candidate may have either, both or —
   * for a manually entered name — neither, so the caller is told which.
   *
   * Readable by whoever may run the recruitment, and by an interviewer the
   * candidate has been delegated to: reading a CV before an interview is the
   * whole point of the delegation.
   */
  async cv(id: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    if (
      !(await this.permissions.hasInterviewDelegation(userId, {
        candidateId: id,
      }))
    ) {
      await this.requireRecruitmentAccess(cand.requisition, userId);
    }

    return {
      candidateId: cand.id,
      name: cand.name,
      // A grant into this API, not the Drive link — see serializeCandidate.
      url:
        this.files.url(cand.cvFileId, 'cv', {
          filename: `${cand.name} — CV`,
        }) ?? cand.cvUrl,
      capturedAt: cand.cvProfileAt?.toISOString() ?? null,
      profile: (cand.cvProfile as unknown as CvProfile | null) ?? null,
    };
  }

  /**
   * A printable CV rendered from the structured profile.
   *
   * Bdjobs applications arrive as fields and no file, so there is nothing to
   * open, print or hand an interviewer. Everything needed is already stored on
   * the candidate; this renders it as the document it should have been.
   *
   * Runs the same authorization check as every other CV route — a generated CV
   * carries exactly the personal data the uploaded one would.
   */
  async cvDocument(candidateId: string, userId: string): Promise<string> {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      select: {
        id: true,
        name: true,
        cvProfile: true,
        cvProfileAt: true,
        requisition: {
          select: {
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);

    const profile = cand.cvProfile as unknown as CvProfile | null;
    if (!profile) {
      throw new NotFoundException(
        'No structured CV is stored for this candidate, so there is nothing to render. Upload a CV file instead.',
      );
    }
    const photo = await this.prisma.candidatePhoto.findUnique({
      where: { candidateId },
      select: { mimeType: true, data: true },
    });
    return buildCvDocument(profile, new Date(), photo ? photoDataUri(photo) : null);
  }

  /**
   * Stream the candidate's CV document to an authorized caller.
   *
   * Runs the same authorization as `cv()` — recruitment access, or an
   * interview delegation on this candidate — and re-checks it at the moment of
   * download rather than trusting a link. Used by API clients; the UI follows
   * the signed grant in `cvUrl`, which is minted behind the same check.
   */
  async streamCv(id: string, userId: string, res: Response): Promise<void> {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    if (
      !(await this.permissions.hasInterviewDelegation(userId, {
        candidateId: id,
      }))
    ) {
      await this.requireRecruitmentAccess(cand.requisition, userId);
    }
    if (!cand.cvFileId) {
      throw new NotFoundException('This candidate has no CV document on file');
    }
    await this.secureFiles.stream(res, cand.cvFileId, {
      filename: `${cand.name} — CV`,
    });
  }

  /**
   * Everything that has happened to this hire, oldest first.
   *
   * Assembled rather than stored: the record of a hire is spread across the
   * requisition's activity log, its sign-off chain, the interviews, the board
   * sheet and the onboarding row, and no single table knows the whole story.
   * Pulling it together here means the printed summary — which goes in a
   * personnel file — says the same thing whoever prints it and whenever.
   */
  async timeline(id: string, userId: string): Promise<TimelineEvent[]> {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: {
        requisition: {
          include: {
            approvalSteps: { orderBy: { orderIndex: 'asc' } },
            activities: { orderBy: { createdAt: 'asc' } },
          },
        },
        rejectedBy: { select: { name: true } },
        regretSentBy: { select: { name: true } },
        interviews: {
          orderBy: { createdAt: 'asc' },
          include: {
            panelists: { include: { user: { select: { name: true } } } },
            evaluations: {
              select: {
                submittedAt: true,
                total: true,
                evaluator: { select: { name: true } },
              },
            },
          },
        },
        boardApprovals: {
          orderBy: { createdAt: 'asc' },
          include: {
            requestedBy: { select: { name: true } },
            hrApprovedBy: { select: { name: true } },
            votes: {
              orderBy: { respondedAt: 'asc' },
              include: { user: { select: { name: true } } },
            },
          },
        },
        onboarding: {
          include: {
            docs: { orderBy: { createdAt: 'asc' } },
            medicalClearedBy: { select: { name: true } },
          },
        },
        salaryFixation: true,
      },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);

    const e: TimelineEvent[] = [];
    const req = cand.requisition;

    // ── The vacancy ──────────────────────────────────────────────────
    pushIf(e, req.createdAt, {
      phase: 'requisition',
      title: `Requisition ${req.code} raised`,
      detail: `${req.designation} · ${req.department} · ${req.unitFactory}`,
      actor: req.raisedBy ?? undefined,
    });
    req.approvalSteps
      .filter((st) => st.actedAt)
      .forEach((st) => {
        pushIf(e, st.actedAt, {
          phase: 'requisition',
          title: `${st.status === 'APPROVED' ? 'Approved' : st.status.toLowerCase()} — ${st.title}`,
          detail: st.note || undefined,
          actor: st.assignee || undefined,
        });
      });
    req.activities
      // A note is the human sentence someone wrote; without one the row only
      // repeats the sign-off step above it as a bare verb ("approved").
      .filter((a) => a.note.trim())
      .forEach((a) => {
        pushIf(e, a.createdAt, {
          phase: 'requisition',
          title: a.note,
          actor: a.actor,
        });
      });

    // ── The candidate ────────────────────────────────────────────────
    pushIf(e, cand.createdAt, {
      phase: 'recruitment',
      title: 'Applied',
      detail: `Source: ${cand.source}`,
    });
    pushIf(e, cand.screenedAt, {
      phase: 'recruitment',
      title: 'CV screened',
      // The score only — the AI's reasoning is printed once, in the candidate
      // block, and repeating a paragraph here would swamp the history.
      detail:
        cand.matchScore != null ? `AI match ${cand.matchScore}/100` : undefined,
    });
    pushIf(e, cand.rejectedAt, {
      phase: 'recruitment',
      title: `Rejected${cand.rejectionStage ? ` at ${cand.rejectionStage.replace(/_/g, ' ')}` : ''}`,
      detail: cand.rejectionReason ?? undefined,
      actor: cand.rejectedBy?.name,
    });
    pushIf(e, cand.regretSentAt, {
      phase: 'recruitment',
      title: 'Regret mail sent',
      actor: cand.regretSentBy?.name,
    });

    // ── Interviews ───────────────────────────────────────────────────
    cand.interviews.forEach((r) => {
      const panel = r.panelists.map((p) => p.user.name).join(', ');
      pushIf(e, r.scheduledAt ?? r.createdAt, {
        phase: 'assessment',
        title: `${r.kind.toLowerCase()} interview ${r.status.toLowerCase()}`,
        detail: [
          r.mode.toLowerCase(),
          r.location || null,
          panel ? `panel: ${panel}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      r.evaluations.forEach((v) => {
        pushIf(e, v.submittedAt, {
          phase: 'assessment',
          title: 'Evaluation submitted',
          detail: `score ${v.total}`,
          actor: v.evaluator.name,
        });
      });
    });

    // ── Board approval ───────────────────────────────────────────────
    cand.boardApprovals.forEach((b) => {
      pushIf(e, b.createdAt, {
        phase: 'approval',
        title: 'Sent for hiring approval',
        actor: b.requestedBy.name,
      });
      b.votes
        .filter((v) => v.respondedAt)
        .forEach((v) => {
          pushIf(e, v.respondedAt, {
            phase: 'approval',
            title: `${v.stage.toUpperCase()} ${v.status}`,
            detail: v.notes || undefined,
            actor: v.user.name,
          });
        });
      pushIf(e, b.hrApprovedAt, {
        phase: 'approval',
        title: "Approved on the board's behalf by HR",
        detail: b.hrApprovalNote ?? undefined,
        actor: b.hrApprovedBy?.name,
      });
      pushIf(e, b.rejectedAt, {
        phase: 'approval',
        title: 'Hiring approval declined',
        detail: b.rejectedReason ?? undefined,
      });
    });

    // ── Onboarding ───────────────────────────────────────────────────
    const ob = cand.onboarding;
    if (ob) {
      pushIf(e, ob.createdAt, {
        phase: 'onboarding',
        title: 'Onboarding started',
      });
      ob.docs.forEach((doc) => {
        pushIf(e, doc.createdAt, {
          phase: 'onboarding',
          title: `Document submitted — ${doc.label}`,
          detail: doc.status,
        });
      });
      pushIf(e, ob.docsSkippedAt, {
        phase: 'onboarding',
        title: 'Document collection skipped',
      });
      pushIf(e, ob.verificationSkippedAt, {
        phase: 'onboarding',
        title: 'Document verification skipped',
      });
      pushIf(e, ob.crossCheckedAt, {
        phase: 'onboarding',
        title: 'AI cross-verification run',
      });
      pushIf(e, ob.medicalNotifiedAt, {
        phase: 'onboarding',
        title: 'Medical team alerted',
      });
      pushIf(e, ob.medicalClearedAt, {
        phase: 'onboarding',
        title: `Medical ${ob.medicalStatus}${ob.medicalManual ? ' (recorded by hand)' : ''}`,
        detail: ob.medicalNote ?? undefined,
        actor: ob.medicalClearedBy?.name,
      });
      pushIf(e, ob.offerSentAt, {
        phase: 'onboarding',
        title: 'Offer letter sent',
      });
      pushIf(e, ob.offerAcceptedAt, {
        phase: 'onboarding',
        title: 'Offer accepted',
      });
      pushIf(e, ob.appointmentSentAt, {
        phase: 'onboarding',
        title: 'Appointment letter issued',
      });
      pushIf(e, ob.hrVerifiedAt, {
        phase: 'onboarding',
        title: 'Final HR verification',
      });
      pushIf(e, ob.itNotifiedAt, {
        phase: 'onboarding',
        title: 'IT provisioning requested',
        detail:
          [ob.itEmail, ob.itAssetId].filter(Boolean).join(' · ') || undefined,
      });
      pushIf(e, ob.archivedAt, {
        phase: 'onboarding',
        title: 'Documents archived',
      });
    }

    return sortTimeline(e);
  }

  async applyHistory(id: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    // Whoever sent the CV in from the factory may see where else that person
    // applied — it is what "Applied 3×" on their own list opens.
    if (cand.createdById !== userId) {
      await this.requireRecruitmentAccess(cand.requisition, userId);
    }

    const ids = sameApplicant(cand, await this.sameApplicantPool([cand])).map(
      (m) => m.id,
    );
    const all = await this.prisma.candidate.findMany({
      where: { id: { in: ids.length ? ids : [cand.id] }, deletedAt: null },
      include: { requisition: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      name: cand.name,
      email: cand.email || null,
      total: all.length,
      applications: all.map((a) => ({
        candidateId: a.id,
        requisitionId: a.requisition.id,
        code: a.requisition.code,
        designation: a.requisition.designation,
        department: a.requisition.department,
        unitFactory: a.requisition.unitFactory,
        postedAt: a.requisition.createdAt.toISOString(),
        appliedAt: a.createdAt.toISOString(),
        viewed: Boolean(a.viewedAt),
        stage: a.stage.toLowerCase(),
      })),
    };
  }

  async markViewed(id: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) return { ok: true };
    if (cand.viewedAt) return { ok: true }; // already viewed, skip write
    await this.requireRecruitmentAccess(cand.requisition, userId);
    await this.prisma.candidate.update({
      where: { id },
      data: { viewedAt: new Date() },
    });
    return { ok: true };
  }

  /** Talent Bank — finalist/selected candidates auto-collected for future recall. */
  async listTalentPool(userId: string) {
    await this.requireTalentBankAccess(userId);
    const rows = await this.prisma.candidate.findMany({
      where: {
        talentPool: true,
        deletedAt: null,
        // Onboarding started = HR has selected them to join — remove from Talent Bank.
        onboarding: null,
      },
      include: {
        requisition: {
          select: {
            id: true,
            code: true,
            designation: true,
            unitFactory: true,
            department: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((c) => ({
      ...serializeCandidate(c, this.files),
      requisition: {
        id: c.requisition.id,
        code: c.requisition.code,
        designation: c.requisition.designation,
        unit: c.requisition.unitFactory,
        department: c.requisition.department,
      },
    }));
  }

  async aiSearchTalentPool(query: string, userId: string) {
    await this.requireTalentBankAccess(userId);
    if (!query?.trim()) return { results: [], summary: '', query: '' };

    const rows = await this.prisma.candidate.findMany({
      where: { talentPool: true, deletedAt: null, onboarding: null },
      include: {
        requisition: {
          select: {
            id: true,
            code: true,
            designation: true,
            unitFactory: true,
            department: true,
          },
        },
      },
      orderBy: { matchScore: 'desc' },
      take: 120,
    });

    if (rows.length === 0)
      return { results: [], summary: 'Talent Bank is empty.', query };

    const aiResult = await this.ai.searchTalentBank({
      query,
      candidates: rows.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.requisition.designation,
        unit: c.requisition.unitFactory ?? '',
        department: c.requisition.department ?? '',
        matchSummary: c.matchSummary ?? '',
        matchScore: c.matchScore,
      })),
    });

    const byId = new Map(rows.map((c) => [c.id, c]));
    const results = aiResult.results
      .map((r) => {
        const c = byId.get(r.id);
        if (!c) return null;
        return {
          ...serializeCandidate(c, this.files),
          requisition: {
            id: c.requisition.id,
            code: c.requisition.code,
            designation: c.requisition.designation,
            unit: c.requisition.unitFactory,
            department: c.requisition.department,
          },
          relevance: r.relevance,
          reason: r.reason,
        };
      })
      .filter(Boolean);

    return { results, summary: aiResult.summary, query };
  }

  /**
   * Import CVs that were dropped straight into the "All CVs" Drive folder (via
   * the shared collection link) but aren't tracked as candidates yet. Idempotent
   * — matches on the Drive file id, so re-running never duplicates.
   */
  async syncFromDrive(reqId: string, userId: string) {
    const req = await this.requireReq(reqId, userId);
    const ws = await this.recruitment.ensureWorkspace(req);
    if (!ws)
      throw new ServiceUnavailableException('Google Drive is not connected.');

    const files = await this.drive.listFiles(ws.allCvFolderId);
    const tracked = await this.prisma.candidate.findMany({
      where: { requisitionId: reqId, cvFileId: { not: null }, deletedAt: null },
      select: { cvFileId: true },
    });
    const known = new Set(tracked.map((c) => c.cvFileId));
    const fresh = files.filter((f) => !known.has(f.id));

    if (fresh.length > 0) {
      await this.prisma.candidate.createMany({
        data: fresh.map((f) => ({
          requisitionId: reqId,
          name: deriveName(f.name),
          source: 'drive',
          cvFileId: f.id,
          cvUrl: f.url,
        })),
      });
      this.notifications.broadcastChange('candidate', reqId, {
        action: 'synced',
      });

      // Auto-screen the newly imported CVs in the background.
      const created = await this.prisma.candidate.findMany({
        where: {
          requisitionId: reqId,
          cvFileId: { in: fresh.map((f) => f.id) },
        },
        select: { id: true },
      });
      this.autoScreenMany(
        created.map((c) => c.id),
        reqId,
      );
    }

    const rows = await this.prisma.candidate.findMany({
      where: { requisitionId: reqId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return {
      imported: fresh.length,
      candidates: rows.map((r) => serializeCandidate(r, this.files)),
    };
  }

  /**
   * Bulk CV upload: one candidate per file, all tagged with one source.
   *
   * Sequential, and each file judged on its own — a Drive hiccup on the
   * ninth CV must not lose the other twenty-nine, and the reply says which
   * ones did not go in. One broadcast at the end rather than one per file.
   */
  async createMany(
    reqId: string,
    dto: BulkCreateCandidatesDto,
    userId: string,
    files: UploadedCv[],
  ) {
    if (!files.length) throw new BadRequestException('Attach at least one CV');
    // Checked once, before any file goes to Drive.
    const intake = await this.requireCvIntake(
      reqId,
      userId,
      dto.referredByCode?.trim() ? 'employee_referral' : dto.cvSource,
    );
    // A referrer who is not in the directory would fail every file the same
    // way — say it once, before anything goes to Drive.
    const referredByCode = dto.referredByCode?.trim() || undefined;
    const referrer = referredByCode
      ? await this.findReferrer(referredByCode)
      : null;
    // The whole batch is one referral — the referrer's open one, if they are
    // still adding to it: the referrer is thanked once, with everyone listed.
    const referral = referrer
      ? await this.referralFor(reqId, referrer, userId)
      : null;
    const names = bulkCandidateNames(
      dto.names,
      files.map((f) => f.originalname),
    );
    const created: ReturnType<typeof serializeCandidate>[] = [];
    const failed: { fileName: string; error: string }[] = [];
    for (const [i, file] of files.entries()) {
      try {
        created.push(
          await this.create(
            reqId,
            {
              name: names[i],
              source: 'upload',
              cvSource: dto.cvSource,
              referredByCode,
            },
            userId,
            file,
            { announce: false, referralId: referral?.id },
          ),
        );
      } catch (err) {
        // Access and Drive being down are the same for every file — stop
        // rather than report thirty identical failures.
        if (
          err instanceof ForbiddenException ||
          err instanceof NotFoundException ||
          err instanceof ServiceUnavailableException
        ) {
          if (!created.length) {
            if (referral?.isNew) await this.dropReferral(referral.id);
            throw err;
          }
        }
        failed.push({
          fileName: file.originalname,
          error: (err as Error).message || 'Could not add this CV',
        });
      }
    }
    if (created.length) {
      this.notifications.broadcastChange('candidate', reqId, {
        action: 'created',
      });
      if (intake.role) {
        await this.notifyFactoryIntake(intake.req, userId, intake.role, created.length);
      }
    }
    if (referral) {
      // A batch arrives all at once, so there is nothing to wait for: the
      // letters go as soon as these CVs have been read for their addresses —
      // the notice queues behind the reads. (CVs sent one at a time are the
      // ones the sweep waits on, to put them in one letter.)
      if (created.length) this.queueReferralNotice(referral.id);
      // Nothing went in, so there is no referral to tell anybody about.
      else if (referral.isNew) await this.dropReferral(referral.id);
    }
    return { created, failed };
  }

  /**
   * @param opts.announce false while a bulk upload is adding its files — it
   *   announces the batch once, at the end.
   * @param opts.referralId the bulk upload's referral, which every file in it
   *   joins. A single referred CV is a referral of its own.
   */
  async create(
    reqId: string,
    dto: CreateCandidateDto,
    userId: string,
    file?: UploadedCv,
    opts: { announce?: boolean; referralId?: string } = {},
  ) {
    const announce = opts.announce ?? true;
    // An employee referral IS the source — nobody should have to pick one
    // as well.
    const cvSource = dto.referredByCode?.trim()
      ? 'employee_referral'
      : dto.cvSource;
    const { req, role } = await this.requireCvIntake(reqId, userId, cvSource);

    // An employee referral arrives with the referrer and the CV together —
    // "referred by X" with nothing to read is not a referral anyone can act on.
    let referrer: Referrer | null = null;
    const referredByCode = dto.referredByCode?.trim();
    if (referredByCode) {
      if (!file) {
        throw new BadRequestException(
          'Attach the CV — an employee referral is added with the candidate’s CV',
        );
      }
      referrer = await this.findReferrer(referredByCode);
    }

    let cvFileId: string | null = null;
    let cvUrl: string | null = null;
    if (file) {
      const ws = await this.recruitment.ensureWorkspace(req);
      if (!ws)
        throw new ServiceUnavailableException('Google Drive is not connected.');
      const uploaded = await this.drive.uploadFile(ws.allCvFolderId, {
        name: cvFileName(dto.name, file.originalname),
        mimeType: file.mimetype,
        buffer: file.buffer,
      });
      // Stays private to the recruitment Google account. Authorized users
      // stream it through this API (common/files/); a Drive
      // "anyone with the link" grant would be permanent and unrecallable.
      cvFileId = uploaded.id;
      cvUrl = uploaded.url;
    }

    const flagEntry = await this.checkRegistry(dto.email, dto.phone);
    // Made last, once the CV is safely on Drive, so a failed upload leaves no
    // empty referral behind. CVs sent in one at a time join the referrer's
    // open referral, so they are one referral and one letter.
    const referralId = referrer
      ? (opts.referralId ??
        (await this.referralFor(reqId, referrer, userId)).id)
      : null;
    const created = await this.prisma.candidate.create({
      data: {
        requisitionId: reqId,
        name: dto.name,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        notes: dto.notes ?? null,
        source: dto.source ?? (file ? 'upload' : 'manual'),
        cvSource: cvSource ?? null,
        createdById: userId,
        addedByRole: role,
        cvFileId,
        cvUrl,
        ...(referrer && {
          referredByCode: referrer.code,
          referredByName: referrer.name,
          referredByDesignation: referrer.designation,
          referralId,
        }),
        ...(flagEntry && {
          isRedFlagged: true,
          redFlagReason: flagEntry.reason,
          redFlaggedAt: new Date(),
          redFlaggedById: flagEntry.flaggedById,
        }),
      },
    });

    if (announce) {
      this.notifications.broadcastChange('candidate', reqId, {
        action: 'created',
      });
      if (role) await this.notifyFactoryIntake(req, userId, role, 1);
    }
    if (cvFileId) {
      this.autoScreen(created.id);
      // Read now, not at the first interview: the row's gender indicator and
      // "Applied 2×" (by email or mobile) both need what is on the CV.
      this.queueCvRead(created.id, reqId);
    }
    return serializeCandidate(created, this.files);
  }

  /** The referring employee, as a referral records them. */
  private async findReferrer(code: string): Promise<Referrer> {
    const emp = await this.prisma.employee.findFirst({
      where: { employeeCode: code },
      select: {
        employeeCode: true,
        designation: true,
        user: { select: { name: true } },
      },
    });
    if (!emp) {
      throw new BadRequestException(
        `No employee with ID ${code} in the directory`,
      );
    }
    return {
      code: emp.employeeCode,
      name: emp.user.name,
      designation: emp.designation,
    };
  }

  /**
   * The referral a referred CV belongs to: the one this person is still
   * adding to for this job and referrer, or a new one.
   */
  private async referralFor(
    reqId: string,
    referrer: Referrer,
    userId: string,
  ): Promise<{ id: string; isNew: boolean }> {
    const open = await this.prisma.candidateReferral.findFirst({
      where: openReferralWhere({
        requisitionId: reqId,
        referrerCode: referrer.code,
        createdById: userId,
        now: new Date(),
      }),
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (open) return { id: open.id, isNew: false };
    const made = await this.prisma.candidateReferral.create({
      data: {
        requisitionId: reqId,
        referrerCode: referrer.code,
        referrerName: referrer.name,
        createdById: userId,
      },
      select: { id: true },
    });
    return { id: made.id, isNew: true };
  }

  private async dropReferral(id: string): Promise<void> {
    await this.prisma.candidateReferral
      .delete({ where: { id } })
      .catch(() => undefined);
  }

  /**
   * Write to a referral's candidates and referrer — behind the CV reads
   * already queued, since a referred CV usually arrives with a name only and
   * the email address comes off the CV.
   */
  private queueReferralNotice(referralId: string): void {
    this.cvReadQueue = this.cvReadQueue
      .then(() => this.candidateMail.notifyReferral(referralId))
      .catch((err: unknown) => {
        this.logger.warn(
          `Referral ${referralId} notice failed: ${(err as Error).message}`,
        );
      });
  }

  /**
   * Send the letters of every referral that has gone quiet — nothing added
   * for five minutes (`referral-window.ts`) — so CVs sent in one at a time
   * are one letter to the referrer, not one each. (A batch is sent as soon as
   * its CVs are read; this also catches one a restart interrupted.) The CVs are read first,
   * where still unread, since that is where most addresses come from; the
   * letters queue behind the reads. After two days a referral is left alone:
   * "thank you for your referral" that late is worse than nothing.
   *
   * Not skipped on the dev server: everything it sends goes through
   * MailService, which keeps it in the outbox there.
   */
  @Cron('*/2 * * * *')
  async sendOverdueReferralNotices(): Promise<void> {
    const overdue = await this.prisma.candidateReferral.findMany({
      where: dueReferralsWhere(new Date()),
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: {
        id: true,
        requisitionId: true,
        candidates: {
          where: { deletedAt: null, email: null, cvFileId: { not: null } },
          select: { id: true },
        },
      },
    });
    for (const r of overdue) {
      for (const c of r.candidates) this.queueCvRead(c.id, r.requisitionId);
      this.queueReferralNotice(r.id);
    }
  }

  /**
   * Who may add a candidate here, and as what.
   *
   * The recruiting side (recruiter, their stand-in, Head of Talent
   * Acquisition, CHRO, super) adds as always. Otherwise the unit's Factory HR
   * or Factory HR Head may send CVs in — only once the job is posted, and
   * always saying where the CV came from, since the recruiter shortlists from
   * what they send. `role` is null on the recruiting side.
   */
  private async requireCvIntake(
    reqId: string,
    userId: string,
    cvSource?: string | null,
  ): Promise<{
    req: Prisma.RequisitionGetPayload<object>;
    role: 'factory_hr' | 'factory_hr_head' | null;
  }> {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    const recruits = await this.permissions.canRunRecruitment(
      userId,
      req.unitFactory,
      req.recruiterId,
      { userId: req.coverRecruiterId, until: req.coverUntil },
    );
    if (recruits) return { req, role: null };

    const role = await this.permissions.cvSubmitterRole(userId, req.unitFactory);
    if (!role) {
      // The recruiting side's own refusal, which names who may.
      await this.requireRecruitmentAccess(req, userId);
    }
    if (req.status !== 'POSTED') {
      throw new BadRequestException(
        'CVs can be sent in once the recruiter has published this job',
      );
    }
    if (!cvSource) {
      throw new BadRequestException('Choose where the CV came from');
    }
    return { req, role };
  }

  /** Tell the recruiting side that the factory has sent CVs in. */
  private async notifyFactoryIntake(
    req: Prisma.RequisitionGetPayload<object>,
    userId: string,
    role: 'factory_hr' | 'factory_hr_head',
    count: number,
  ) {
    const [sender, recipients] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      }),
      this.permissions.recruitmentRecipients(req.unitFactory, req.recruiterId, {
        userId: req.coverRecruiterId,
        until: req.coverUntil,
      }),
    ]);
    const who = `${sender?.name ?? 'Factory HR'} (${role === 'factory_hr_head' ? 'Factory HR Head' : 'Factory HR'})`;
    await this.notifications.notifyMany(recipients, {
      type: 'factory_cv_intake',
      title: 'CVs sent in from the factory',
      message: `${who} sent ${count} CV${count === 1 ? '' : 's'} for ${req.code} · ${req.designation}. They are in the pipeline as Applied for you to shortlist.`,
      link: `/requisitions/${req.id}?tab=recruitment`,
    });
  }

  /**
   * The CVs this user sent in to a requisition, for their own list on the
   * Profile & Posting tab — with the gender indicator and "Applied N×", but
   * nothing of the recruiter's assessment.
   */
  async submittedByMe(reqId: string, userId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    const role = await this.permissions.cvSubmitterRole(userId, req.unitFactory);
    if (!role) {
      await this.requireRecruitmentAccess(req, userId);
    }
    const rows = await this.prisma.candidate.findMany({
      where: { requisitionId: reqId, createdById: userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const counts = applyCounts(rows, await this.sameApplicantPool(rows));
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email ?? '',
      phone: c.phone ?? '',
      gender: normalizeGender(c.gender),
      cvSource: c.cvSource,
      cvSourceLabel: c.cvSource
        ? (CV_SOURCE_LABEL[c.cvSource as keyof typeof CV_SOURCE_LABEL] ??
          c.cvSource)
        : null,
      referral: c.referredByCode
        ? {
            employeeCode: c.referredByCode,
            name: c.referredByName ?? '',
            designation: c.referredByDesignation ?? null,
          }
        : null,
      cvUrl:
        this.files.url(c.cvFileId, 'cv', { filename: `${c.name} — CV` }) ??
        c.cvUrl,
      applyCount: counts.get(c.id) ?? 1,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  /**
   * Every live application that could be the same person as one of `rows`:
   * same email or same last-ten-digits mobile, across all requisitions. One
   * query for the whole page; `apply-identity.ts` then does the matching.
   */
  private async sameApplicantPool(
    rows: { id: string; email?: string | null; phone?: string | null }[],
  ): Promise<{ id: string; email: string | null; phone: string | null }[]> {
    const emails = [
      ...new Set(rows.map((r) => emailKey(r.email)).filter(Boolean)),
    ] as string[];
    const phones = [
      ...new Set(rows.map((r) => phoneKey(r.phone)).filter(Boolean)),
    ] as string[];
    if (!emails.length && !phones.length) return [];
    return this.prisma.$queryRaw<
      { id: string; email: string | null; phone: string | null }[]
    >`
      SELECT id, email, phone FROM candidates
      WHERE deleted_at IS NULL
        AND (
          lower(btrim(email)) = ANY(${emails}::text[])
          OR right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = ANY(${phones}::text[])
        )`;
  }

  /**
   * Read uploaded CVs one at a time, in the background, then refresh the
   * pipeline. Sequential so a bulk upload of thirty does not fire thirty AI
   * calls at once.
   */
  private queueCvRead(candidateId: string, reqId: string): void {
    this.cvReadQueue = this.cvReadQueue
      .then(async () => {
        if (await this.ensureCvProfile(candidateId)) {
          this.notifications.broadcastChange('candidate', reqId, {
            action: 'cv_read',
          });
        }
      })
      .catch(() => undefined);
  }

  private cvReadQueue: Promise<void> = Promise.resolve();
  /**
   * Candidates already queued for a gender read in this process, so a CV
   * the AI cannot decide on is not re-read on every pipeline load.
   */
  private readonly genderTried = new Set<string>();

  /** The same person's gender from another application, if one has it. */
  private async genderFromOtherApplications(cand: {
    id: string;
    email: string | null;
    phone: string | null;
  }): Promise<string | null> {
    const others = sameApplicant(cand, await this.sameApplicantPool([cand]))
      .map((r) => r.id)
      .filter((id) => id !== cand.id);
    if (!others.length) return null;
    const hit = await this.prisma.candidate.findFirst({
      where: { id: { in: others }, gender: { not: null } },
      select: { gender: true },
    });
    return normalizeGender(hit?.gender);
  }

  /**
   * Internal (Gmail ingestion): create a candidate from an emailed CV with no
   * acting user — the cron already validated the requisition. Returns null
   * when the sender already applied to this requisition (dedup by email).
   */
  async importEmailedCv(
    reqId: string,
    sender: { name: string; email: string },
    file: UploadedCv,
  ) {
    const existing = await this.prisma.candidate.findFirst({
      where: {
        requisitionId: reqId,
        email: { equals: sender.email, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existing) return null;

    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req) return null;
    const ws = await this.recruitment.ensureWorkspace(req);
    if (!ws) return null;

    const uploaded = await this.drive.uploadFile(ws.allCvFolderId, {
      name: cvFileName(sender.name, file.originalname),
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    // Stays private to the recruitment Google account. Authorized users
    // stream it through this API (common/files/); a Drive
    // "anyone with the link" grant would be permanent and unrecallable.
    const created = await this.prisma.candidate.create({
      data: {
        requisitionId: reqId,
        name: sender.name,
        email: sender.email,
        source: 'email',
        cvFileId: uploaded.id,
        cvUrl: uploaded.url,
      },
    });
    this.notifications.broadcastChange('candidate', reqId, {
      action: 'created',
    });
    this.autoScreen(created.id);
    // Gender and "Applied N×" need what is on the CV, as for any upload.
    this.queueCvRead(created.id, reqId);
    return created;
  }

  async update(id: string, dto: UpdateCandidateDto, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);

    const data: Prisma.CandidateUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.salaryExpectation !== undefined)
      data.salaryExpectation = dto.salaryExpectation;
    if (dto.talentPool !== undefined) {
      data.talentPool = dto.talentPool;
      if (dto.talentPool && !cand.talentPool) {
        this.syncTalentBankMatchesForOpenRequisitions().catch((err) =>
          this.logger.warn(
            `Talent Bank match sync (new pool candidate) failed: ${(err as Error).message}`,
          ),
        );
      }
    }

    if (dto.stage) {
      const stage = dto.stage.toUpperCase() as CandidateStage;
      if (stage === 'AI_SHORTLISTED') {
        throw new BadRequestException(
          '“AI Shortlisted” is set automatically by AI screening and can’t be assigned manually.',
        );
      }
      // Selecting someone leads straight to board approval, and the board
      // signs off on a salary. Selecting first and fixing it later is what
      // left candidates stuck at "Send for Board Approval" — so the figure is
      // settled before the selection, not discovered missing after it.
      if (stage === 'SELECTED' && cand.stage !== 'SELECTED') {
        const sf = await this.prisma.salaryFixation.findUnique({
          where: { candidateId: id },
          select: {
            status: true,
            proposedSalary: true,
            proposedSalaryOverride: true,
          },
        });
        const amount = sf?.proposedSalaryOverride ?? sf?.proposedSalary ?? null;
        if (sf?.status !== 'fixed' || amount == null) {
          throw new BadRequestException(
            `Finalize ${cand.name}'s salary before selecting them — board approval signs off on that figure.`,
          );
        }
      }
      data.stage = stage;
      // Finalist / selected → auto-add to Talent Bank.
      if (stage === 'FINAL' || stage === 'SELECTED') {
        data.talentPool = true;
        // New pool member — re-run matching for every currently open
        // requisition so this candidate can surface as a suggestion right
        // away, without waiting for the daily backstop.
        this.syncTalentBankMatchesForOpenRequisitions().catch((err) =>
          this.logger.warn(
            `Talent Bank match sync (new pool candidate) failed: ${(err as Error).message}`,
          ),
        );
      }
      // When a candidate is selected, auto-reject all remaining applied candidates.
      if (stage === 'SELECTED') {
        await this.prisma.candidate.updateMany({
          where: {
            requisitionId: cand.requisitionId,
            stage: 'APPLIED',
            id: { not: id },
          },
          data: { stage: 'REJECTED' },
        });
      }
      // Mirror the move in Drive: shift the CV into the stage's folder.
      const ws =
        (cand.requisition.drive as unknown as RequisitionDriveMap | null) ??
        null;
      if (ws?.allCvFolderId && cand.cvFileId) {
        await this.drive.moveFile(
          cand.cvFileId,
          this.drive.stageFolderId(ws, stage),
        );
      }
    }

    const updated = await this.prisma.candidate.update({ where: { id }, data });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'updated',
    });
    return serializeCandidate(updated, this.files);
  }

  async uploadCv(id: string, userId: string, file: UploadedCv) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);

    const ws = await this.recruitment.ensureWorkspace(cand.requisition);
    if (!ws)
      throw new ServiceUnavailableException('Google Drive is not connected.');
    const target = this.drive.stageFolderId(ws, cand.stage);
    const uploaded = await this.drive.uploadFile(target, {
      name: cvFileName(cand.name, file.originalname),
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    // Stays private to the recruitment Google account. Authorized users
    // stream it through this API (common/files/); a Drive
    // "anyone with the link" grant would be permanent and unrecallable.

    const updated = await this.prisma.candidate.update({
      where: { id },
      data: {
        cvFileId: uploaded.id,
        cvUrl: uploaded.url,
        source: cand.source === 'manual' ? 'upload' : cand.source,
      },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'cv_uploaded',
    });
    // A CV just arrived — screen it in the background (if still at Applied).
    if (updated.stage === 'APPLIED') this.autoScreen(updated.id);
    return serializeCandidate(updated, this.files);
  }

  async remove(id: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);

    // Remove the CV from Drive too — otherwise it leaks and re-imports on sync.
    if (cand.cvFileId && this.drive.isConfigured()) {
      try {
        await this.drive.discardFile(cand.cvFileId);
      } catch (err) {
        this.logger.warn(
          `Could not remove Drive file ${cand.cvFileId} for candidate ${id}: ${
            (err as Error).message
          }`,
        );
      }
    }

    await this.prisma.candidate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'removed',
    });
    return { id };
  }

  // --- email ---------------------------------------------------------------

  mailConfigured(): boolean {
    return this.mail.isConfigured();
  }

  async emailCandidate(id: string, userId: string, dto: EmailCandidateDto) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);
    if (!cand.email) {
      throw new BadRequestException(
        'This candidate has no email address on file',
      );
    }

    const { text, html } = renderPlainMessage(dto.subject, dto.message);
    await this.mail.send({ to: cand.email, subject: dto.subject, text, html });

    // Keep a light trail of contact in the candidate's notes.
    const stamp = new Date().toISOString().slice(0, 10);
    const trail = `[${stamp}] Emailed: ${dto.subject}`;
    await this.prisma.candidate.update({
      where: { id },
      data: { notes: cand.notes ? `${cand.notes}\n${trail}` : trail },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'emailed',
    });
    return { sent: true, to: cand.email };
  }

  // --- AI CV screening -----------------------------------------------------

  aiScreeningEnabled(): boolean {
    return this.ai.isConfigured();
  }

  /** Screen one candidate's CV against the role (manual / re-screen). */
  async screenCandidate(id: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI screening is not configured');
    }
    if (!cand.cvFileId && !cand.cvProfile) {
      throw new BadRequestException('This candidate has no CV to screen');
    }
    const updated = await this.runScreen(cand);
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'screened',
    });
    return serializeCandidate(updated ?? cand, this.files);
  }

  /** Screen every un-screened applied candidate in a requisition (runs in background). */
  async screenRequisition(reqId: string, userId: string) {
    await this.requireReq(reqId, userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI screening is not configured');
    }

    // If a job is already active for this requisition, return its current status.
    const existing = this.screeningJobs.get(reqId);
    if (existing?.active) {
      return { started: false, alreadyRunning: true, ...existing };
    }

    const pending = await this.prisma.candidate.findMany({
      where: {
        requisitionId: reqId,
        // SHORTLISTED is included for the Bdjobs intake, which lands already
        // shortlisted: it still needs a score, and runScreen will not move it.
        stage: { in: ['APPLIED', 'SHORTLISTED'] },
        // Either kind of CV — a Drive document, or a structured profile.
        // cvProfileAt is set in lockstep with cvProfile and filters cleanly,
        // which a nullable Json column does not.
        OR: [{ cvFileId: { not: null } }, { cvProfileAt: { not: null } }],
        screenedAt: null,
        deletedAt: null,
      },
      include: { requisition: true },
    });

    if (pending.length === 0) {
      return {
        started: false,
        alreadyRunning: false,
        total: 0,
        done: 0,
        shortlisted: 0,
        active: false,
      };
    }

    const job: ScreeningJob = {
      done: 0,
      total: pending.length,
      shortlisted: 0,
      active: true,
    };
    this.screeningJobs.set(reqId, job);
    this.notifications.broadcastRaw('screening:progress', { reqId, ...job });

    // Fire and forget — returns immediately so the HTTP response is not held open.
    void this.runScreeningJob(reqId, pending);

    return {
      started: true,
      alreadyRunning: false,
      total: pending.length,
      done: 0,
      shortlisted: 0,
      active: true,
    };
  }

  private async runScreeningJob(
    reqId: string,
    pending: Prisma.CandidateGetPayload<{ include: { requisition: true } }>[],
  ) {
    let done = 0;
    let shortlisted = 0;
    // Sequential to stay within provider rate limits.
    for (const c of pending) {
      try {
        const u = await this.runScreen(c);
        if (u?.stage === 'AI_SHORTLISTED') shortlisted++;
      } catch (err) {
        this.logger.warn(
          `Screening candidate ${c.id} failed: ${(err as Error).message}`,
        );
      }
      done++;
      const job: ScreeningJob = {
        done,
        total: pending.length,
        shortlisted,
        active: done < pending.length,
      };
      this.screeningJobs.set(reqId, job);
      this.notifications.broadcastRaw('screening:progress', { reqId, ...job });
    }
    this.notifications.broadcastChange('candidate', reqId, {
      action: 'screened_bulk',
    });
  }

  /**
   * AI side-by-side comparison of a requisition's finalists (interview / final /
   * selected candidates) using CV screening, exam scores and panel marks. Purely
   * advisory output for Head of Talent Acquisition's final decision — nothing is persisted.
   */
  async compareFinalists(reqId: string, userId: string) {
    const req = await this.requireReq(reqId, userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI comparison is not configured');
    }
    const finalists = await this.prisma.candidate.findMany({
      where: {
        requisitionId: reqId,
        stage: { in: ['INTERVIEW', 'FINAL', 'SELECTED'] },
        deletedAt: null,
      },
      include: {
        interviews: { include: { evaluations: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (finalists.length < 2) {
      throw new BadRequestException(
        'Need at least two candidates in the interview, final or selected stage to compare',
      );
    }
    const profile = req.roleProfile as {
      requirements?: string[];
    } | null;
    const salaryFixations = await this.prisma.salaryFixation.findMany({
      where: { candidateId: { in: finalists.map((c) => c.id) } },
      select: {
        candidateId: true,
        writtenTestTotal: true,
        writtenTestObtained: true,
        aiTestTotal: true,
        aiTestObtained: true,
      },
    });
    const examsByCandidate = new Map(
      salaryFixations.map((s) => [
        s.candidateId,
        [
          ...(s.writtenTestTotal !== null && s.writtenTestObtained !== null
            ? [
                {
                  type: 'Written Test',
                  score: s.writtenTestObtained,
                  maxScore: s.writtenTestTotal,
                },
              ]
            : []),
          ...(s.aiTestTotal !== null && s.aiTestObtained !== null
            ? [
                {
                  type: 'AI Proficiency Test',
                  score: s.aiTestObtained,
                  maxScore: s.aiTestTotal,
                },
              ]
            : []),
        ],
      ]),
    );
    const result = await this.ai.compareFinalists({
      role: {
        designation: req.designation,
        department: req.department,
        jobDescription: req.jobDescription ?? '',
        requirements: profile?.requirements ?? [],
      },
      finalists: finalists.map((c) => ({
        id: c.id,
        name: c.name,
        stage: c.stage.toLowerCase(),
        matchScore: c.matchScore,
        matchSummary: c.matchSummary,
        exams: examsByCandidate.get(c.id) ?? [],
        interviews: c.interviews
          .filter((r) => r.evaluations.length)
          .map((r) => ({
            kind: r.kind.toLowerCase(),
            avgTotal:
              Math.round(
                (r.evaluations.reduce((s, e) => s + e.total, 0) /
                  r.evaluations.length) *
                  10,
              ) / 10,
            evaluations: r.evaluations.length,
            comments: r.evaluations
              .map((e) => e.comments?.trim() ?? '')
              .filter(Boolean)
              .slice(0, 4),
          })),
      })),
    });
    // Resolve ids back to names so the UI never has to cross-reference.
    const byId = new Map(finalists.map((c) => [c.id, c]));
    return {
      recommendation: result.recommendation,
      ranking: result.ranking.map((r) => {
        const c = byId.get(r.id);
        return {
          ...r,
          name: c?.name ?? 'Unknown',
          stage: c?.stage.toLowerCase() ?? '',
          matchScore: c?.matchScore ?? null,
        };
      }),
    };
  }

  /**
   * Run the AI screen + persist the score; auto-advance APPLIED → AI_SHORTLISTED.
   *
   * Two kinds of CV reach this method. A document (uploaded, or collected from
   * Drive) is read by the vision model. A Bdjobs application is fields, never a
   * file — its structured profile is rendered to text and scored by the same
   * prompt, so a Bdjobs candidate is not the one applicant in the pipeline with
   * no match score.
   *
   * The stage is only ever advanced from APPLIED. Candidates who arrive already
   * shortlisted (Bdjobs forwards only its own shortlist) therefore gain a score
   * without being moved backwards into an AI stage.
   */
  /**
   * Make sure this candidate has a structured CV on file.
   *
   * Bdjobs sends fields; somebody who applied on the careers page sends a
   * document, and a document is not something the interviewer's summary, the
   * shortlisting sheet or the board papers can read. This reads it once with
   * the AI and stores the result in the system's own shape.
   *
   * Never overwrites an existing profile: a structured intake is the
   * authoritative one and a re-read of the same PDF would only add drift.
   * Pass `force` where a recruiter has explicitly asked for a re-scan.
   *
   * Returns true when a profile is on file afterwards, false when there was
   * nothing to read or the AI is off — callers treat it as best-effort.
   */
  async ensureCvProfile(candidateId: string, force = false): Promise<boolean> {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      select: {
        id: true,
        name: true,
        cvFileId: true,
        cvProfile: true,
        email: true,
        phone: true,
        gender: true,
      },
    });
    if (!cand) return false;

    // "Applied 2×": the same person may already be known on another
    // application — take their gender from there before asking the AI.
    if (!cand.gender) {
      const inherited = await this.genderFromOtherApplications(cand);
      if (inherited) {
        await this.prisma.candidate.update({
          where: { id: cand.id },
          data: { gender: inherited },
        });
        cand.gender = inherited;
      }
    }

    if (cand.cvProfile && !force) {
      if (cand.gender) return true;
      // Read before gender was asked for. The profile is never overwritten
      // (see above), so ask for the gender alone.
      const fromProfile = normalizeGender(
        (cand.cvProfile as { personal?: { gender?: unknown } })?.personal
          ?.gender,
      );
      if (fromProfile) {
        await this.prisma.candidate.update({
          where: { id: cand.id },
          data: { gender: fromProfile },
        });
        return true;
      }
      if (!cand.cvFileId || !this.ai.isConfigured()) return true;
      try {
        const { buffer, mimeType } = await this.drive.getFileBuffer(
          cand.cvFileId,
        );
        const extracted = await this.ai.extractCvProfile({
          mimeType,
          base64: buffer.toString('base64'),
        });
        const gender = normalizeGender(extracted.gender);
        if (gender) {
          await this.prisma.candidate.update({
            where: { id: cand.id },
            data: { gender },
          });
        }
      } catch (err) {
        this.logger.warn(
          `Could not read the gender from ${cand.name}'s CV: ${(err as Error).message}`,
        );
      }
      return true;
    }
    if (!cand.cvFileId || !this.ai.isConfigured()) return false;

    try {
      const { buffer, mimeType } = await this.drive.getFileBuffer(cand.cvFileId);
      const extracted = await this.ai.extractCvProfile({
        mimeType,
        base64: buffer.toString('base64'),
      });
      // A read that found nothing is not worth storing: it would look like a
      // CV with no history rather than a CV nobody has read yet, and it would
      // stop this ever trying again.
      if (extracted.employment.length === 0 && extracted.education.length === 0) {
        this.logger.warn(`CV extraction found nothing for ${cand.name}`);
        // No history worth storing, but the male / female indicator is
        // always decided — keep that much.
        const gender = normalizeGender(extracted.gender);
        if (!cand.gender && gender) {
          await this.prisma.candidate.update({
            where: { id: cand.id },
            data: { gender },
          });
        }
        return false;
      }
      const profile = extractedCvToProfile(extracted);
      await this.prisma.candidate.update({
        where: { id: cand.id },
        data: {
          cvProfile: profile as unknown as Prisma.InputJsonValue,
          cvProfileAt: new Date(),
          // Backfill only what nobody has typed in by hand.
          ...(profile.contact.currentAddress
            ? { cvAddress: profile.contact.currentAddress.slice(0, 300) }
            : {}),
          ...(!cand.gender && profile.personal.gender
            ? { gender: profile.personal.gender }
            : {}),
          // Email and mobile make "Applied 2×" work for a CV that arrived
          // with only a name.
          ...(!cand.email && profile.contact.email
            ? { email: profile.contact.email.slice(0, 254) }
            : {}),
          ...(!cand.phone && phoneKey(profile.contact.phone)
            ? { phone: profile.contact.phone!.slice(0, 40) }
            : {}),
        },
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `Could not read the CV for ${cand.name}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Read the CV in the background, and say nothing if it fails.
   *
   * Called where somebody is about to need the summary — when an interview
   * is arranged — so it is ready by the time the panel opens the form. It
   * must never delay or fail the thing that triggered it.
   */
  scheduleCvProfile(candidateId: string): void {
    // A page that lists interviews calls this on every load. A CV the AI
    // cannot read would otherwise be sent to it again each time, so one try
    // per candidate every few hours is enough.
    const last = this.cvReadAttempts.get(candidateId) ?? 0;
    if (Date.now() - last < CV_READ_RETRY_MS) return;
    this.cvReadAttempts.set(candidateId, Date.now());
    void this.ensureCvProfile(candidateId).catch(() => undefined);
  }

  private readonly cvReadAttempts = new Map<string, number>();

  private async runScreen(
    cand: Prisma.CandidateGetPayload<{ include: { requisition: true } }>,
  ): Promise<CandidateRow | null> {
    if (!this.ai.isConfigured()) return null;
    const rp =
      (cand.requisition.roleProfile as {
        responsibilities?: string[];
        requirements?: string[];
      } | null) ?? null;

    const role: ScreenRole = {
      designation: cand.requisition.designation,
      jobDescription: cand.requisition.jobDescription,
      education: cand.requisition.education,
      experience: cand.requisition.experience,
      others: cand.requisition.others,
      placeOfPosting: cand.requisition.placeOfPosting,
      responsibilities: Array.isArray(rp?.responsibilities)
        ? rp?.responsibilities
        : undefined,
      requirements: Array.isArray(rp?.requirements)
        ? rp?.requirements
        : undefined,
    };

    let result: ScreenResult;
    if (cand.cvFileId) {
      const { buffer, mimeType } = await this.drive.getFileBuffer(
        cand.cvFileId,
      );
      result = await this.ai.screenCv({
        ...role,
        cvMimeType: mimeType,
        cvBase64: buffer.toString('base64'),
      });
    } else if (cand.cvProfile) {
      result = await this.ai.screenCvText({
        ...role,
        cvText: cvProfileToText(cand.cvProfile as unknown as CvProfile),
      });
    } else {
      return null;
    }

    const data: Prisma.CandidateUpdateInput = {
      matchScore: result.score,
      matchSummary: result.summary || null,
      matchDetails:
        result.criteria.length > 0
          ? (result.criteria as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      screenedAt: new Date(),
    };
    // Backfill contact details the AI found in the CV — only when we don't
    // already have them (never overwrite details entered by a person).
    if (!cand.email && result.email) data.email = result.email;
    if (!cand.phone && result.phone) data.phone = result.phone;
    // The address only prefills a letter, which HR reads before sending, so a
    // fresh reading is allowed to replace an older one.
    if (result.address) data.cvAddress = result.address;
    const { shortlistThreshold } = await this.settings.getAiConfig();
    if (cand.stage === 'APPLIED' && result.score >= shortlistThreshold) {
      data.stage = 'AI_SHORTLISTED';
      // Move the CV into the "02 AI Shortlisted" Drive folder.
      const ws =
        (cand.requisition.drive as unknown as RequisitionDriveMap | null) ??
        null;
      if (ws?.allCvFolderId && cand.cvFileId) {
        try {
          await this.drive.moveFile(
            cand.cvFileId,
            this.drive.stageFolderId(ws, 'AI_SHORTLISTED'),
          );
        } catch (err) {
          this.logger.warn(
            `Could not move CV ${cand.cvFileId} to AI Shortlisted: ${(err as Error).message}`,
          );
        }
      }
    }
    return this.prisma.candidate.update({ where: { id: cand.id }, data });
  }

  /**
   * A candidate arrived from an external job board. Announce it and screen it.
   *
   * The Bdjobs webhook writes its own candidate row (it has payload details
   * this service never sees), which used to mean two things silently did not
   * happen: no `candidate:changed` broadcast, so open pipelines did not show
   * the applicant until someone refreshed; and no AI screen, so Bdjobs
   * candidates were the only ones with no match score. Both belong to this
   * module, so both live here rather than in the integration.
   */
  onCandidateImported(candidateId: string, reqId: string): void {
    this.notifications.broadcastChange('candidate', reqId, {
      action: 'imported',
    });
    this.autoScreen(candidateId);
  }

  /** Fire-and-forget screen used right after a CV first arrives. */
  private autoScreen(candidateId: string): void {
    if (!this.ai.isConfigured()) return;
    void (async () => {
      try {
        if (!(await this.settings.getAiConfig()).autoScreen) return;
        const cand = await this.prisma.candidate.findUnique({
          where: { id: candidateId },
          include: { requisition: true },
        });
        if (cand && screenable(cand)) {
          await this.runScreen(cand);
          this.notifications.broadcastChange('candidate', cand.requisitionId, {
            action: 'screened',
          });
        }
      } catch (err) {
        this.logger.warn(`Auto-screen failed: ${(err as Error).message}`);
      }
    })();
  }

  /**
   * Background-screen a batch of freshly-imported CVs **sequentially** (to stay
   * within provider rate limits), broadcasting after each so the pipeline
   * updates live as scores come in. Fire-and-forget — never blocks the caller.
   */
  private autoScreenMany(candidateIds: string[], reqId: string): void {
    if (!this.ai.isConfigured() || candidateIds.length === 0) return;
    void (async () => {
      if (!(await this.settings.getAiConfig()).autoScreen) return;
      for (const id of candidateIds) {
        try {
          const cand = await this.prisma.candidate.findUnique({
            where: { id },
            include: { requisition: true },
          });
          if (cand && screenable(cand) && !cand.screenedAt) {
            await this.runScreen(cand);
            this.notifications.broadcastChange('candidate', reqId, {
              action: 'screened',
            });
          }
        } catch (err) {
          this.logger.warn(
            `Auto-screen (batch) failed for ${id}: ${(err as Error).message}`,
          );
        }
      }
    })();
  }

  // --- public careers & status (no auth) -----------------------------------

  async listOpenJobs() {
    const reqs = await this.prisma.requisition.findMany({
      where: { status: 'POSTED' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        code: true,
        designation: true,
        department: true,
        unitFactory: true,
        placeOfPosting: true,
        employmentNature: true,
        requiredPosts: true,
        jobDescription: true,
        createdAt: true,
        posting: true,
      },
    });
    // Past its closing date, a job leaves the career page — the requisition
    // stays POSTED for the recruiter, it just stops taking applications.
    const now = new Date();
    return reqs.filter((r) => applicationsOpen(r.posting, now)).map((r) => ({
      id: r.id,
      code: r.code,
      designation: r.designation,
      department: r.department,
      unitFactory: r.unitFactory,
      placeOfPosting: r.placeOfPosting,
      employmentNature: r.employmentNature.toLowerCase(),
      requiredPosts: r.requiredPosts,
      summary: r.jobDescription
        ? r.jobDescription
            .replace(/<[^>]+>/g, '')
            .slice(0, 200)
            .trim()
        : null,
      postedAt: r.createdAt.toISOString(),
      closesAt: applicationsCloseAt(r.posting)?.toISOString() ?? null,
    }));
  }

  async applicationStatus(email: string) {
    if (!email || email.trim().length < 5) {
      throw new BadRequestException('Please provide a valid email address');
    }
    const candidates = await this.prisma.candidate.findMany({
      where: {
        email: { equals: email.trim(), mode: 'insensitive' },
        deletedAt: null,
      },
      include: {
        requisition: {
          select: { code: true, designation: true, unitFactory: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return candidates.map((c) => ({
      requisitionId: c.requisitionId,
      /** The number in their confirmation email. */
      applicationId: applicationId(c.applicationNo, c.createdAt),
      code: c.requisition.code,
      designation: c.requisition.designation,
      unitFactory: c.requisition.unitFactory,
      stage: c.stage.toLowerCase(),
      appliedAt: c.createdAt.toISOString(),
    }));
  }

  // --- public job application (no auth) ------------------------------------

  /** Refuse a public application once the closing date has passed. */
  private assertApplicationsOpen(posting: unknown): void {
    if (applicationsOpen(posting)) return;
    const lastDay = lastDayToApply(posting);
    throw new NotFoundException(
      `Applications for this position closed${lastDay ? ` on ${lastDay}` : ''}.`,
    );
  }

  async publicJobInfo(reqId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req || req.status !== 'POSTED') {
      throw new NotFoundException('This position is not open for applications');
    }
    this.assertApplicationsOpen(req.posting);
    return {
      code: req.code,
      designation: req.designation,
      unitFactory: req.unitFactory,
      department: req.department,
      placeOfPosting: req.placeOfPosting,
      requiredPosts: req.requiredPosts,
      employmentNature: req.employmentNature.toLowerCase(),
    };
  }

  async publicApply(reqId: string, dto: PublicApplyDto, file?: UploadedCv) {
    if (!file) throw new BadRequestException('Please attach your CV');
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req || req.status !== 'POSTED') {
      throw new NotFoundException('This position is not open for applications');
    }
    // Before the CV reaches Drive: a closed position must not collect one.
    this.assertApplicationsOpen(req.posting);
    const ws = await this.recruitment.ensureWorkspace(req);
    if (!ws) {
      throw new ServiceUnavailableException(
        'Applications are temporarily unavailable. Please try again later.',
      );
    }
    const uploaded = await this.drive.uploadFile(ws.allCvFolderId, {
      name: cvFileName(dto.name, file.originalname),
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    // Stays private to the recruitment Google account. Authorized users
    // stream it through this API (common/files/); a Drive
    // "anyone with the link" grant would be permanent and unrecallable.
    const flagEntry = await this.checkRegistry(dto.email, dto.phone);
    const created = await this.prisma.candidate.create({
      data: {
        requisitionId: reqId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone ?? null,
        salaryExpectation: dto.salaryExpectation ?? null,
        source: 'application',
        cvFileId: uploaded.id,
        cvUrl: uploaded.url,
        ...(flagEntry && {
          isRedFlagged: true,
          redFlagReason: flagEntry.reason,
          redFlaggedAt: new Date(),
          redFlaggedById: flagEntry.flaggedById,
        }),
      },
    });
    this.notifications.broadcastChange('candidate', reqId, {
      action: 'application',
    });
    // Auto-screen the fresh CV against the role in the background.
    this.autoScreen(created.id);
    // Gender and "Applied N×" need what is on the CV, as for any upload.
    this.queueCvRead(created.id, reqId);
    // Not awaited: the applicant should not wait on the mail server, and a
    // confirmation that cannot go must not undo an application that has.
    void this.candidateMail.sendApplicationReceived(created.id);
    return {
      ok: true,
      applicationId: applicationId(created.applicationNo, created.createdAt),
      position: designationLabel(req.designation, req.alternateDesignations),
    };
  }

  // --- access control ------------------------------------------------------

  private async requireReq(reqId: string, userId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    await this.requireRecruitmentAccess(req, userId);
    return req;
  }

  /**
   * Recruitment (the CV pipeline) is restricted to Head of Talent Acquisition, CHRO and super
   * users — both viewing and managing. Department Head / Factory HR / SBU Head /
   * Medical never see it.
   */
  /**
   * Post-approval work is Head of Talent Acquisition / CHRO / super — plus the Corporate
   * Recruiter assigned to this requisition. Takes the requisition (not just
   * its unit) so the assigned recruiter is always considered.
   */
  /**
   * May this user act on this candidate? Public, because a controller
   * sometimes needs the gate without the work behind it.
   */
  async requireCandidateAccess(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      select: {
        requisition: {
          select: {
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);
  }

  private async requireRecruitmentAccess(
    req: RecruitmentSubject,
    userId: string,
  ) {
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      'access recruitment for this requisition',
      // Whoever is standing in while the recruiter is on leave.
      { userId: req.coverRecruiterId, until: req.coverUntil },
    );
  }

  /**
   * Copy a talent-bank candidate into a target requisition's pipeline.
   * `force` skips the duplicate-email guard — used when HR explicitly
   * confirms they want to add someone again despite an existing entry.
   */
  async copyToRequisition(
    candidateId: string,
    requisitionId: string,
    userId: string,
    force = false,
  ) {
    await this.requireTalentBankAccess(userId);

    const source = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { onboarding: { select: { id: true } } },
    });
    if (!source) throw new NotFoundException('Candidate not found');
    if (source.onboarding) {
      throw new BadRequestException(
        'This candidate has already joined the company and cannot be sourced again',
      );
    }

    const req = await this.prisma.requisition.findUnique({
      where: { id: requisitionId },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    // Reading the bank is global, but adding someone to a pipeline is a write
    // to that requisition — a recruiter may only source into requisitions they
    // are actually running. Head of Talent Acquisition / CHRO / super are unaffected.
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      'add a Talent Bank candidate to this requisition',
    );
    if (!['APPROVED', 'POSTED'].includes(req.status)) {
      throw new BadRequestException(
        'Target requisition must be approved or posted',
      );
    }

    if (source.email && !force) {
      // Only an ACTIVE entry counts as a duplicate — once someone's been
      // removed (soft-deleted) from this pipeline, re-adding them is a
      // normal action, not a conflict.
      const dup = await this.prisma.candidate.findFirst({
        where: { requisitionId, email: source.email, deletedAt: null },
      });
      if (dup)
        throw new ConflictException(
          'A candidate with this email is already in that pipeline',
        );
    }

    const copy = await this.prisma.candidate.create({
      data: {
        requisitionId,
        name: source.name,
        email: source.email,
        phone: source.phone,
        source: 'manual',
        stage: 'APPLIED' as CandidateStage,
        cvFileId: source.cvFileId,
        cvUrl: source.cvUrl,
        // Already read once — carry it, rather than re-read the same CV.
        gender: source.gender,
        cvProfile: source.cvProfile ?? Prisma.JsonNull,
        cvProfileAt: source.cvProfileAt,
        cvAddress: source.cvAddress,
        notes: `Sourced from Talent Bank`,
      },
    });
    if (!copy.gender && copy.cvFileId) this.queueCvRead(copy.id, requisitionId);

    return serializeCandidate(copy, this.files);
  }

  /** Global recruitment role check (for cross-requisition views like talent pool). */
  /**
   * Talent Bank access — Head of Talent Acquisition, CHRO, super users and Corporate
   * Recruiters.
   *
   * The bank is a shared pool by design: a recruiter sourcing for their own
   * requisition needs to reach candidates who originally applied to someone
   * else's. Kept separate from `requireRecruitmentRole` so the maintenance
   * routines below stay restricted.
   */
  private async requireTalentBankAccess(userId: string) {
    const ok =
      (await this.permissions.isSuperUser(userId)) ||
      Boolean(
        await this.prisma.roleAssignment.findFirst({
          where: {
            userId,
            role: {
              key: { in: ['corporate_hr', 'chro', 'corporate_recruiter'] },
            },
          },
        }),
      );
    if (!ok) {
      throw new ForbiddenException(
        'Only Head of Talent Acquisition, CHRO, a Corporate Recruiter or a super user can view the Talent Bank',
      );
    }
  }

  /** Stricter gate for maintenance routines that act across every requisition. */
  private async requireRecruitmentRole(userId: string) {
    const ok =
      (await this.permissions.isSuperUser(userId)) ||
      Boolean(
        await this.prisma.roleAssignment.findFirst({
          where: { userId, role: { key: { in: ['corporate_hr', 'chro'] } } },
        }),
      );
    if (!ok) {
      throw new ForbiddenException(
        'Only Head of Talent Acquisition, CHRO or a super user can perform this action',
      );
    }
  }

  // --- Talent Bank auto-sourcing --------------------------------------------

  /** HR-facing read for the "Talent Bank Matches" tab on a requisition. */
  async listTalentBankMatches(reqId: string, userId: string) {
    await this.requireReq(reqId, userId);
    const rows = await this.prisma.talentBankMatch.findMany({
      where: {
        requisitionId: reqId,
        // Defense in depth: re-filter eligibility live, so a not-yet-pruned
        // row can never surface a candidate who left the pool or joined.
        candidate: { talentPool: true, deletedAt: null, onboarding: null },
      },
      include: {
        candidate: {
          include: {
            requisition: {
              select: {
                id: true,
                code: true,
                designation: true,
                unitFactory: true,
                department: true,
              },
            },
          },
        },
      },
      orderBy: { relevance: 'desc' },
    });
    const deduped = dedupeByEmail(rows, (m) => m.candidate.email);

    // Live status against THIS requisition's own pipeline — not the pool —
    // so the UI can tell "never added" apart from "already added" apart
    // from "added, then removed" (which is fine to add again).
    const emails = [
      ...new Set(deduped.map((m) => m.candidate.email).filter(Boolean)),
    ] as string[];
    const existingInTarget =
      emails.length > 0
        ? await this.prisma.candidate.findMany({
            where: { requisitionId: reqId, email: { in: emails } },
            select: { email: true, deletedAt: true },
          })
        : [];
    const statusByEmail = new Map<string, 'in_pipeline' | 'removed'>();
    for (const c of existingInTarget) {
      if (!c.email) continue;
      const key = c.email.trim().toLowerCase();
      if (!c.deletedAt) statusByEmail.set(key, 'in_pipeline');
      else if (!statusByEmail.has(key)) statusByEmail.set(key, 'removed');
    }

    return deduped.map((m) => ({
      ...serializeCandidate(m.candidate, this.files),
      requisition: {
        id: m.candidate.requisition.id,
        code: m.candidate.requisition.code,
        designation: m.candidate.requisition.designation,
        unit: m.candidate.requisition.unitFactory,
        department: m.candidate.requisition.department,
      },
      relevance: m.relevance,
      reason: m.reason,
      matchedAt: m.computedAt.toISOString(),
      pipelineStatus:
        statusByEmail.get(m.candidate.email?.trim().toLowerCase() ?? '') ??
        'not_added',
    }));
  }

  /** Manual "Rescan" — an on-demand refresh alongside the automatic triggers. */
  async rescanTalentBankMatches(reqId: string, userId: string) {
    await this.requireReq(reqId, userId);
    await this.syncTalentBankMatchesForRequisition(reqId);
    return this.listTalentBankMatches(reqId, userId);
  }

  /** Fires after a requisition reaches APPROVED/POSTED — non-blocking. */
  syncTalentBankMatchesOnRequisitionEvent(reqId: string): void {
    this.syncTalentBankMatchesForRequisition(reqId).catch((err) =>
      this.logger.warn(
        `Talent Bank match sync failed for requisition ${reqId}: ${(err as Error).message}`,
      ),
    );
  }

  /** Daily backstop — mirrors the ZingHR cron + manual-sync pattern. */
  @Cron('15 22 * * *')
  async talentBankMatchDailySync(): Promise<void> {
    if (this.sandbox.skipJob('Talent Bank daily match')) return;
    if (!this.ai.isConfigured()) return;
    this.logger.log('Talent Bank daily match sync starting');
    await this.syncTalentBankMatchesForOpenRequisitions();
    this.logger.log('Talent Bank daily match sync complete');
  }

  private async syncTalentBankMatchesForOpenRequisitions(): Promise<void> {
    const openReqs = await this.prisma.requisition.findMany({
      where: { status: { in: ['APPROVED', 'POSTED'] } },
      select: { id: true },
    });
    // Sequential — one AI call per requisition, same rate-limit-respecting
    // approach as the bulk CV-screening job.
    for (const r of openReqs) {
      await this.syncTalentBankMatchesForRequisition(r.id).catch((err) =>
        this.logger.warn(
          `Talent Bank match sync failed for requisition ${r.id}: ${(err as Error).message}`,
        ),
      );
    }
  }

  /**
   * Recompute and persist Talent Bank matches for one requisition — fully
   * replaces its existing rows with the freshly computed set (an empty
   * result means "no matches right now", not "leave stale rows").
   */
  private async syncTalentBankMatchesForRequisition(
    reqId: string,
  ): Promise<void> {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req || !['APPROVED', 'POSTED'].includes(req.status)) return;
    if (!this.ai.isConfigured()) return;

    const poolRows = await this.prisma.candidate.findMany({
      where: {
        talentPool: true,
        deletedAt: null,
        onboarding: null,
        requisitionId: { not: reqId },
      },
      include: {
        requisition: {
          select: { designation: true, unitFactory: true, department: true },
        },
      },
      orderBy: { matchScore: 'desc' },
      take: 120,
    });
    // The same person can end up in the pool more than once (applied to
    // several past requisitions) — dedupe by email so they're never offered
    // as two separate "matches" for the same role, which would trip the
    // duplicate-email guard the moment the second one is added.
    const pool = dedupeByEmail(poolRows, (c) => c.email);

    const existing = await this.prisma.talentBankMatch.findMany({
      where: { requisitionId: reqId },
      select: { candidateId: true },
    });
    const existingIds = new Set(existing.map((m) => m.candidateId));

    if (pool.length === 0) {
      await this.prisma.talentBankMatch.deleteMany({
        where: { requisitionId: reqId },
      });
      return;
    }

    const rp =
      (req.roleProfile as {
        responsibilities?: string[];
        requirements?: string[];
      } | null) ?? null;
    const result = await this.ai.matchTalentBankToRequisition({
      requisition: {
        designation: req.designation,
        jobDescription: req.jobDescription,
        education: req.education,
        experience: req.experience,
        others: req.others,
        placeOfPosting: req.placeOfPosting,
        responsibilities: Array.isArray(rp?.responsibilities)
          ? rp?.responsibilities
          : undefined,
        requirements: Array.isArray(rp?.requirements)
          ? rp?.requirements
          : undefined,
      },
      candidates: pool.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.requisition.designation,
        unit: c.requisition.unitFactory ?? '',
        department: c.requisition.department ?? '',
        matchSummary: c.matchSummary ?? '',
        matchScore: c.matchScore,
      })),
    });

    const freshIds = result.results.map((r) => r.id);
    await this.prisma.$transaction([
      this.prisma.talentBankMatch.deleteMany({
        where: { requisitionId: reqId, candidateId: { notIn: freshIds } },
      }),
      ...result.results.map((r) =>
        this.prisma.talentBankMatch.upsert({
          where: {
            requisitionId_candidateId: {
              requisitionId: reqId,
              candidateId: r.id,
            },
          },
          create: {
            requisitionId: reqId,
            candidateId: r.id,
            relevance: r.relevance,
            reason: r.reason,
          },
          update: { relevance: r.relevance, reason: r.reason },
        }),
      ),
    ]);

    const newlyMatched = result.results.filter((r) => !existingIds.has(r.id));
    if (newlyMatched.length > 0) {
      const hrIds = await this.permissions.recruitmentRecipients(
        req.unitFactory,
        req.recruiterId,
        // The stand-in, if the recruiter is away — they are the one who would
        // act on a new match.
        { userId: req.coverRecruiterId, until: req.coverUntil },
      );
      await this.notifications.notifyMany(hrIds, {
        type: 'talent_bank_match',
        title: 'New Talent Bank matches',
        message: `${newlyMatched.length} Talent Bank candidate${newlyMatched.length > 1 ? 's' : ''} matched for ${req.code} · ${req.designation}.`,
        link: `/requisitions/${reqId}`,
      });
      this.notifications.broadcastChange('candidate', reqId, {
        action: 'talent_bank_matched',
      });
    }
  }

  // --- red flag -----------------------------------------------------------

  /** Corp HR or CHRO flags a candidate. Adds email + phone to registry so future applications auto-flag. */
  async flagCandidate(id: string, userId: string, reason: string) {
    const candidate = await this.prisma.candidate.findUnique({
      where: { id },
      include: {
        requisition: {
          select: {
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(candidate.requisition, userId);

    const normPhone = normalizePhone(candidate.phone);
    const normEmail = candidate.email?.toLowerCase() ?? null;

    // Build transaction: update candidate + upsert separate registry records per identity key.
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.candidate.update({
        where: { id },
        data: {
          isRedFlagged: true,
          redFlagReason: reason,
          redFlaggedAt: new Date(),
          redFlaggedById: userId,
        },
      }),
    ];
    if (normEmail) {
      ops.push(
        this.prisma.redFlagRegistry.upsert({
          where: { email: normEmail },
          create: { email: normEmail, reason, flaggedById: userId },
          update: { reason, flaggedById: userId },
        }),
      );
    }
    if (normPhone) {
      ops.push(
        this.prisma.redFlagRegistry.upsert({
          where: { phone: normPhone },
          create: { phone: normPhone, reason, flaggedById: userId },
          update: { reason, flaggedById: userId },
        }),
      );
    }
    await this.prisma.$transaction(ops);

    return { ok: true };
  }

  /** Remove red flag from a candidate (does NOT remove registry entry — other candidates may share it). */
  async unflagCandidate(id: string, userId: string) {
    const candidate = await this.prisma.candidate.findUnique({
      where: { id },
      include: {
        requisition: {
          select: {
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(candidate.requisition, userId);

    await this.prisma.candidate.update({
      where: { id },
      data: {
        isRedFlagged: false,
        redFlagReason: null,
        redFlaggedAt: null,
        redFlaggedById: null,
      },
    });
    return { ok: true };
  }

  /** Check registry and return flag data if the email or phone is registered. */
  private async checkRegistry(email?: string | null, phone?: string | null) {
    if (!email && !phone) return null;
    const normPhone = normalizePhone(phone);
    return this.prisma.redFlagRegistry.findFirst({
      where: {
        OR: [
          ...(email ? [{ email: email.toLowerCase() }] : []),
          ...(normPhone ? [{ phone: normPhone }] : []),
        ],
      },
    });
  }

  /** Retroactively share every existing CV file as "anyone with link → reader". */
  /**
   * Take public access back off every CV.
   *
   * This method used to do the opposite: it published every CV in the database
   * as "anyone with the link". CVs are now streamed by this API to authorized
   * users only, so the sweep runs the other way — it revokes the grants that
   * earlier uploads left behind. Idempotent: a file that is already private
   * costs one no-op call.
   *
   * `scripts/revoke-public-drive-access.ts` does the same for every other
   * document class (joining docs, medical reports, attachments) and has a
   * dry-run mode; prefer it for the full sweep.
   */
  async revokePublicCvAccess(userId: string) {
    await this.requireRecruitmentRole(userId);
    const candidates = await this.prisma.candidate.findMany({
      where: { cvFileId: { not: null } },
      select: { id: true, cvFileId: true },
    });
    let revoked = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        await this.drive.revokeAnyoneAccess(c.cvFileId!);
        revoked++;
      } catch (e) {
        // Log the ids only — never the candidate's name.
        this.logger.warn(
          `Revoke failed for candidate ${c.id} file ${c.cvFileId}: ${(e as Error)?.message}`,
        );
        failed++;
      }
    }
    return { total: candidates.length, revoked, failed };
  }
}

/** Strip all non-digit characters for phone comparison. Returns null for empty/null. */
/**
 * Is there anything here for the AI to read, at a stage where a score still
 * means something?
 *
 * Two kinds of CV qualify: a Drive document and a structured Bdjobs profile.
 * Two stages qualify: APPLIED, and SHORTLISTED — which is where a Bdjobs
 * application lands, since Bdjobs only forwards candidates its own recruiter
 * already shortlisted. Screening never moves a SHORTLISTED candidate; it only
 * gives them the match score every other candidate has.
 */
function screenable(cand: {
  cvFileId: string | null;
  cvProfile: Prisma.JsonValue | null;
  stage: CandidateStage;
}): boolean {
  const hasCv = Boolean(cand.cvFileId) || cand.cvProfile != null;
  return (
    hasCv &&
    (cand.stage === CandidateStage.APPLIED ||
      cand.stage === CandidateStage.SHORTLISTED)
  );
}

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits || null;
}

function cvFileName(candidate: string, original: string): string {
  const dot = original.lastIndexOf('.');
  const ext = dot >= 0 ? original.slice(dot) : '';
  return `${candidate} — CV${ext}`;
}

/** Best-effort candidate name from an uploaded CV's filename. */
function deriveName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  // "John_Doe-CV" / "john doe resume" → "John Doe …"
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Candidate';
}

/**
 * The same real person can end up as multiple candidate rows (applied to
 * several past requisitions) — keep only the first occurrence per email so
 * they're never surfaced twice. Rows are pre-sorted by preference (e.g.
 * highest match score / relevance first), so "first occurrence" wins.
 * Rows without an email can't be deduped and are always kept.
 */
function dedupeByEmail<T>(rows: T[], getEmail: (row: T) => string | null): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const email = getEmail(row)?.trim().toLowerCase();
    if (!email) {
      out.push(row);
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(row);
  }
  return out;
}

/**
 * `cvUrl` is a link into THIS API, not into Google Drive.
 *
 * The CV file is private to the recruitment Google account; the caller gets a
 * short-lived signed grant, minted only because they have already passed the
 * authorization check that produced this row. A candidate whose CV lives
 * somewhere else entirely (an external link with no Drive file) keeps that URL.
 */
function serializeCandidate(c: CandidateRow, files: FileGrantService) {
  return {
    id: c.id,
    requisitionId: c.requisitionId,
    /** APP-2026-00031 — what the candidate quotes; the search finds it. */
    applicationId: applicationId(c.applicationNo, c.createdAt),
    name: c.name,
    email: c.email ?? '',
    phone: c.phone ?? '',
    source: c.source,
    /** Where the recruiter found the CV — a CV_SOURCES key, or null. */
    cvSource: c.cvSource ?? null,
    /** 'male' | 'female' off the CV, or null when unknown. */
    gender: normalizeGender(c.gender),
    /** Latest title · company · years, from the CV once it has been read. */
    headline: cvHeadline(c.cvProfile),
    /** Set when the unit's Factory HR / Factory HR Head sent this CV in. */
    addedBy: c.addedByRole
      ? { name: c.createdBy?.name ?? null, role: c.addedByRole }
      : null,
    stage: c.stage.toLowerCase(),
    cvFileId: c.cvFileId,
    cvUrl:
      files.url(c.cvFileId, 'cv', { filename: `${c.name} — CV` }) ?? c.cvUrl,
    /**
     * True when a CV can be rendered from stored data even though no file was
     * ever sent — every Bdjobs applicant, who applies as fields rather than a
     * document. Lets the UI offer the generated CV instead of showing nothing.
     */
    hasGeneratedCv: Boolean(c.cvProfile),
    notes: c.notes ?? '',
    /** Employee referral — who put them forward, as they were at the time. */
    referral: c.referredByCode
      ? {
          employeeCode: c.referredByCode,
          name: c.referredByName ?? '',
          designation: c.referredByDesignation ?? null,
        }
      : null,
    salaryExpectation: c.salaryExpectation ?? null,
    matchScore: c.matchScore,
    matchSummary: c.matchSummary ?? '',
    matchDetails: Array.isArray(c.matchDetails) ? c.matchDetails : null,
    screenedAt: c.screenedAt ? c.screenedAt.toISOString() : null,
    viewedAt: c.viewedAt ? c.viewedAt.toISOString() : null,
    talentPool: c.talentPool,
    isRedFlagged: c.isRedFlagged,
    redFlagReason: c.redFlagReason ?? null,
    redFlaggedAt: c.redFlaggedAt ? c.redFlaggedAt.toISOString() : null,
    // Where a rejection happened, so a factory interviewer's call after the
    // first interview reads differently from a CV screening rejection.
    rejectedAt: c.rejectedAt ? c.rejectedAt.toISOString() : null,
    rejectionStage: c.rejectionStage ?? null,
    rejectionReason: c.rejectionReason ?? null,
    rejectedByName: c.rejectedBy?.name ?? null,
    /** The regret letter, once sent — it goes at most once. */
    regretSentAt: c.regretSentAt ? c.regretSentAt.toISOString() : null,
    regretSentByName: c.regretSentBy?.name ?? null,
    /**
     * Set while the first interview is out with somebody else, so the
     * recruiter's Interviews tab can show the candidate without offering
     * controls over a round it did not arrange. Null on every query that did
     * not ask for the hand-offs.
     */
    firstInterviewHold: firstInterviewHold(c),
    /**
     * The first interview was handed to the factory. Once they have given
     * their verdict the hold lifts and the recruiter books the second or
     * final round as usual — but the factory's first round stays theirs, so
     * the recruiter sees it and cannot edit it. False where the query did
     * not ask for the hand-offs.
     */
    /** Interview kinds already held — 'first' | 'second' | 'final'. */
    completedRounds: [
      ...new Set((c.interviews ?? []).map((r) => r.kind.toLowerCase())),
    ],
    firstRoundByFactory: (c.interviewDelegations ?? []).some(
      (d) => !d.revokedAt,
    ),
    /**
     * Where the Factory HR Head sign-off stands, when there is one — so a
     * return or a rejection by the Head reads as theirs, not Factory HR's.
     */
    firstInterviewApproval: c.firstInterviewApproval
      ? {
          status: c.firstInterviewApproval.status.toLowerCase(),
          note: c.firstInterviewApproval.decisionNote ?? null,
          decidedByName: c.firstInterviewApproval.decidedBy?.name ?? null,
        }
      : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
