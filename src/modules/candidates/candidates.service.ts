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
import type { RequisitionDriveMap } from '../integrations/google/google.types';
import { RecruitmentService } from './recruitment.service';
import { FileGrantService } from '../../common/files/file-grant.service';
import { SecureFileService } from '../../common/files/secure-file.service';
import type { CvProfile } from './cv/cv-profile.types';
import { buildCvDocument } from './cv/cv-document';
import { cvProfileToText } from './cv/cv-text';
import { pushIf, sortTimeline, type TimelineEvent } from './candidate-timeline';
import {
  BulkRejectDto,
  CandidateQueryDto,
  CreateCandidateDto,
  EmailCandidateDto,
  PublicApplyDto,
  UpdateCandidateDto,
} from './dto/candidate.dto';

/** The subset of a Multer file we use (typed locally to avoid extra deps). */
export interface UploadedCv {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

type CandidateRow = Prisma.CandidateGetPayload<object> & {
  /** Present only where the query includes it; the name of whoever rejected. */
  rejectedBy?: { name: string } | null;
};

interface ScreeningJob {
  done: number;
  total: number;
  shortlisted: number;
  active: boolean;
}

@Injectable()
export class CandidatesService {
  private readonly screeningJobs = new Map<string, ScreeningJob>();
  private readonly logger = new Logger(CandidatesService.name);

  constructor(
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
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
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

    // applyCount: how many times each email has applied across ALL requisitions.
    const emails = [
      ...new Set(rows.map((r) => r.email).filter(Boolean)),
    ] as string[];
    const emailCounts =
      emails.length > 0
        ? await this.prisma.candidate.groupBy({
            by: ['email'],
            where: { email: { in: emails } },
            _count: { id: true },
          })
        : [];
    const countMap = new Map(emailCounts.map((e) => [e.email, e._count.id]));

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
        applyCount: r.email ? (countMap.get(r.email) ?? 1) : 1,
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
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
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
    const result = await this.prisma.candidate.updateMany({
      where: {
        requisitionId: reqId,
        stage: { in: ['APPLIED', 'AI_SHORTLISTED'] },
        matchScore: { lte: dto.maxScore },
      },
      data: { stage: 'REJECTED' },
    });
    this.notifications.broadcastChange('candidate', reqId, {
      action: 'bulk_rejected',
    });
    return { rejected: result.count };
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
    return buildCvDocument(profile);
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
    await this.requireRecruitmentAccess(cand.requisition, userId);

    if (!cand.email)
      return { name: cand.name, email: null, total: 1, applications: [] };

    const all = await this.prisma.candidate.findMany({
      where: { email: cand.email, deletedAt: null },
      include: { requisition: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      name: cand.name,
      email: cand.email,
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

  async create(
    reqId: string,
    dto: CreateCandidateDto,
    userId: string,
    file?: UploadedCv,
  ) {
    const req = await this.requireReq(reqId, userId);

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
    const created = await this.prisma.candidate.create({
      data: {
        requisitionId: reqId,
        name: dto.name,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        notes: dto.notes ?? null,
        source: dto.source ?? (file ? 'upload' : 'manual'),
        createdById: userId,
        cvFileId,
        cvUrl,
        ...(flagEntry && {
          isRedFlagged: true,
          redFlagReason: flagEntry.reason,
          redFlaggedAt: new Date(),
          redFlaggedById: flagEntry.flaggedById,
        }),
      },
    });

    this.notifications.broadcastChange('candidate', reqId, {
      action: 'created',
    });
    if (cvFileId) this.autoScreen(created.id);
    return serializeCandidate(created, this.files);
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

    await this.mail.send({
      to: cand.email,
      subject: dto.subject,
      text: dto.message,
      html: renderEmailHtml(dto.message),
    });

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
      },
    });
    return reqs.map((r) => ({
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
      code: c.requisition.code,
      designation: c.requisition.designation,
      unitFactory: c.requisition.unitFactory,
      stage: c.stage.toLowerCase(),
      appliedAt: c.createdAt.toISOString(),
    }));
  }

  // --- public job application (no auth) ------------------------------------

  async publicJobInfo(reqId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req || req.status !== 'POSTED') {
      throw new NotFoundException('This position is not open for applications');
    }
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
    return { ok: true };
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
        notes: `Sourced from Talent Bank`,
      },
    });

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Wrap a plain-text message in a simple branded HTML email. */
function renderEmailHtml(message: string): string {
  const body = escapeHtml(message).replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
        <tr><td style="background:#1877c0;padding:18px 28px;color:#ffffff;font-size:18px;font-weight:bold">DBL Group — Recruitment</td></tr>
        <tr><td style="padding:28px;font-size:14px;line-height:1.7;color:#334155">${body}</td></tr>
        <tr><td style="padding:18px 28px;background:#f8fafc;color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0">
          This message was sent by DBL Group Recruitment. Please do not share it.
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
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
    name: c.name,
    email: c.email ?? '',
    phone: c.phone ?? '',
    source: c.source,
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
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
