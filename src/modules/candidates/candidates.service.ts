import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CandidateStage, Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { DriveService } from '../integrations/google/drive.service';
import { MailService } from '../integrations/mail/mail.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import { SettingsService } from '../settings/settings.service';
import type { RequisitionDriveMap } from '../integrations/google/google.types';
import { RecruitmentService } from './recruitment.service';
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

type CandidateRow = Prisma.CandidateGetPayload<object>;

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

    const where: Prisma.CandidateWhereInput = { requisitionId: reqId };
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
      }),
      this.prisma.candidate.count({ where }),
    ]);

    // Stats across ALL candidates for this requisition (ignores current filter).
    const baseWhere = { requisitionId: reqId };
    const [s90, s75, s50, s25, unscreened, notViewed, finalists, stageCounts] =
      await Promise.all([
        this.prisma.candidate.count({ where: { ...baseWhere, matchScore: { gte: 90 } } }),
        this.prisma.candidate.count({ where: { ...baseWhere, matchScore: { gte: 75, lt: 90 } } }),
        this.prisma.candidate.count({ where: { ...baseWhere, matchScore: { gte: 50, lt: 75 } } }),
        this.prisma.candidate.count({ where: { ...baseWhere, matchScore: { gte: 25, lt: 50 } } }),
        this.prisma.candidate.count({ where: { ...baseWhere, screenedAt: null } }),
        this.prisma.candidate.count({ where: { ...baseWhere, viewedAt: null } }),
        this.prisma.candidate.count({ where: { ...baseWhere, stage: { in: ['INTERVIEW', 'FINAL', 'SELECTED'] } } }),
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
    const emails = [...new Set(rows.map((r) => r.email).filter(Boolean))] as string[];
    const emailCounts =
      emails.length > 0
        ? await this.prisma.candidate.groupBy({
            by: ['email'],
            where: { email: { in: emails } },
            _count: { id: true },
          })
        : [];
    const countMap = new Map(emailCounts.map((e) => [e.email, e._count.id]));

    return {
      items: rows.map((r) => ({
        ...serializeCandidate(r),
        applyCount: r.email ? (countMap.get(r.email) ?? 1) : 1,
      })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
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

  getScreeningStatus(reqId: string): { done: number; total: number; shortlisted: number; active: boolean } {
    return this.screeningJobs.get(reqId) ?? { done: 0, total: 0, shortlisted: 0, active: false };
  }

  async exportCandidates(reqId: string, userId: string, query: CandidateQueryDto = {}) {
    const req = await this.requireReq(reqId, userId);

    const where: Prisma.CandidateWhereInput = { requisitionId: reqId };
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

    const ws = wb.addWorksheet('Candidates', { views: [{ state: 'frozen', ySplit: 1 }] });

    // Column definitions
    ws.columns = [
      { header: '#',              key: 'no',       width: 5  },
      { header: 'Name',           key: 'name',     width: 28 },
      { header: 'Email',          key: 'email',    width: 30 },
      { header: 'Phone',          key: 'phone',    width: 16 },
      { header: 'AI Match Score', key: 'score',    width: 16 },
      { header: 'Stage',          key: 'stage',    width: 16 },
      { header: 'Applied Date',   key: 'applied',  width: 14 },
      { header: 'Source',         key: 'source',   width: 12 },
      { header: 'Notes',          key: 'notes',    width: 40 },
    ];

    // Style header row
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1877C0' } };
      cell.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF0F5999' } } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    headerRow.height = 22;

    // Data rows
    rows.forEach((r, idx) => {
      const score = r.matchScore != null ? r.matchScore : null;
      const stageFill = STAGE_COLOR[r.stage] ?? 'FFFFFFFF';

      const row = ws.addRow({
        no:      idx + 1,
        name:    r.name ?? '',
        email:   r.email ?? '',
        phone:   r.phone ?? '',
        score:   score,
        stage:   STAGE_LABEL[r.stage] ?? r.stage,
        applied: r.createdAt.toISOString().slice(0, 10),
        source:  r.source ?? '',
        notes:   r.notes ?? '',
      });

      row.height = 18;

      // Alternate row background
      const rowBg = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC';

      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.alignment = { vertical: 'middle', wrapText: false };
        cell.font      = { size: 10 };

        if (colNum === 6) {
          // Stage column — colored fill
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: stageFill } };
          cell.font = { size: 10, bold: true };
        } else if (colNum === 5 && score != null) {
          // Score column — green if ≥75, amber if ≥50, red otherwise
          const scoreBg =
            score >= 75 ? 'FFD1FAE5' :
            score >= 50 ? 'FFFEF3C7' :
            'FFFEE2E2';
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: scoreBg } };
          cell.font = { size: 10, bold: true };
          cell.numFmt = '0"%"'; // show as number (score is 0-100)
        } else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
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
    this.notifications.broadcastChange('candidate', reqId, { action: 'bulk_rejected' });
    return { rejected: result.count };
  }

  async applyHistory(id: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);

    if (!cand.email) return { name: cand.name, email: null, total: 1, applications: [] };

    const all = await this.prisma.candidate.findMany({
      where: { email: cand.email },
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
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);
    await this.prisma.candidate.update({
      where: { id },
      data: { viewedAt: new Date() },
    });
    return { ok: true };
  }

  /** Suitable-but-not-selected candidates kept for future recall (talent pool). */
  async listTalentPool(userId: string) {
    await this.requireRecruitmentRole(userId);
    const rows = await this.prisma.candidate.findMany({
      where: { talentPool: true },
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
      ...serializeCandidate(c),
      requisition: {
        id: c.requisition.id,
        code: c.requisition.code,
        designation: c.requisition.designation,
        unit: c.requisition.unitFactory,
        department: c.requisition.department,
      },
    }));
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
      where: { requisitionId: reqId, cvFileId: { not: null } },
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
      where: { requisitionId: reqId },
      orderBy: { createdAt: 'desc' },
    });
    return { imported: fresh.length, candidates: rows.map(serializeCandidate) };
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
      this.drive.shareAnyoneWithLink(uploaded.id, 'reader').catch((e) => this.logger.warn(`CV share failed for ${uploaded.id}: ${e?.message}`));
      cvFileId = uploaded.id;
      cvUrl = uploaded.url;
    }

    const created = await this.prisma.candidate.create({
      data: {
        requisitionId: reqId,
        name: dto.name,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        notes: dto.notes ?? null,
        source: dto.source ?? (file ? 'upload' : 'manual'),
        cvFileId,
        cvUrl,
      },
    });

    this.notifications.broadcastChange('candidate', reqId, {
      action: 'created',
    });
    if (cvFileId) this.autoScreen(created.id);
    return serializeCandidate(created);
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
    this.drive.shareAnyoneWithLink(uploaded.id, 'reader').catch((e) => this.logger.warn(`CV share failed for ${uploaded.id}: ${e?.message}`));
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
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);

    const data: Prisma.CandidateUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.talentPool !== undefined) data.talentPool = dto.talentPool;

    if (dto.stage) {
      const stage = dto.stage.toUpperCase() as CandidateStage;
      if (stage === 'AI_SHORTLISTED') {
        throw new BadRequestException(
          '“AI Shortlisted” is set automatically by AI screening and can’t be assigned manually.',
        );
      }
      data.stage = stage;
      // When a candidate is selected, auto-reject all remaining applied candidates.
      if (stage === 'SELECTED') {
        await this.prisma.candidate.updateMany({
          where: { requisitionId: cand.requisitionId, stage: 'APPLIED', id: { not: id } },
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
    return serializeCandidate(updated);
  }

  async uploadCv(id: string, userId: string, file: UploadedCv) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);

    const ws = await this.recruitment.ensureWorkspace(cand.requisition);
    if (!ws)
      throw new ServiceUnavailableException('Google Drive is not connected.');
    const target = this.drive.stageFolderId(ws, cand.stage);
    const uploaded = await this.drive.uploadFile(target, {
      name: cvFileName(cand.name, file.originalname),
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    this.drive.shareAnyoneWithLink(uploaded.id, 'reader').catch((e) => this.logger.warn(`CV share failed for ${uploaded.id}: ${e?.message}`));

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
    return serializeCandidate(updated);
  }

  async remove(id: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);

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

    await this.prisma.candidate.delete({ where: { id } });
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
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);
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
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI screening is not configured');
    }
    if (!cand.cvFileId) {
      throw new BadRequestException('This candidate has no CV to screen');
    }
    const updated = await this.runScreen(cand);
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'screened',
    });
    return serializeCandidate(updated ?? cand);
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
        stage: 'APPLIED',
        cvFileId: { not: null },
        screenedAt: null,
      },
      include: { requisition: true },
    });

    if (pending.length === 0) {
      return { started: false, alreadyRunning: false, total: 0, done: 0, shortlisted: 0, active: false };
    }

    const job: ScreeningJob = { done: 0, total: pending.length, shortlisted: 0, active: true };
    this.screeningJobs.set(reqId, job);
    this.notifications.broadcastRaw('screening:progress', { reqId, ...job });

    // Fire and forget — returns immediately so the HTTP response is not held open.
    void this.runScreeningJob(reqId, pending);

    return { started: true, alreadyRunning: false, total: pending.length, done: 0, shortlisted: 0, active: true };
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
        this.logger.warn(`Screening candidate ${c.id} failed: ${(err as Error).message}`);
      }
      done++;
      const job: ScreeningJob = { done, total: pending.length, shortlisted, active: done < pending.length };
      this.screeningJobs.set(reqId, job);
      this.notifications.broadcastRaw('screening:progress', { reqId, ...job });
    }
    this.notifications.broadcastChange('candidate', reqId, { action: 'screened_bulk' });
  }

  /**
   * AI side-by-side comparison of a requisition's finalists (interview / final /
   * selected candidates) using CV screening, exam scores and panel marks. Purely
   * advisory output for Corporate HR's final decision — nothing is persisted.
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
      },
      include: {
        examAttempts: { where: { totalScore: { not: null } } },
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
        exams: c.examAttempts.map((a) => ({
          type: a.examType.toLowerCase(),
          score: a.totalScore ?? 0,
          maxScore: a.maxScore,
        })),
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

  /** Run the AI screen + persist the score; auto-advance APPLIED → AI_SHORTLISTED. */
  private async runScreen(
    cand: Prisma.CandidateGetPayload<{ include: { requisition: true } }>,
  ): Promise<CandidateRow | null> {
    if (!cand.cvFileId || !this.ai.isConfigured()) return null;
    const { buffer, mimeType } = await this.drive.getFileBuffer(cand.cvFileId);
    const rp =
      (cand.requisition.roleProfile as {
        responsibilities?: string[];
        requirements?: string[];
      } | null) ?? null;

    const result = await this.ai.screenCv({
      cvMimeType: mimeType,
      cvBase64: buffer.toString('base64'),
      designation: cand.requisition.designation,
      jobDescription: cand.requisition.jobDescription,
      education: cand.requisition.education,
      experience: cand.requisition.experience,
      others: cand.requisition.others,
      responsibilities: Array.isArray(rp?.responsibilities)
        ? rp?.responsibilities
        : undefined,
      requirements: Array.isArray(rp?.requirements)
        ? rp?.requirements
        : undefined,
    });

    const data: Prisma.CandidateUpdateInput = {
      matchScore: result.score,
      matchSummary: result.summary || null,
      screenedAt: new Date(),
    };
    // Backfill contact details the AI found in the CV — only when we don't
    // already have them (never overwrite details entered by a person).
    if (!cand.email && result.email) data.email = result.email;
    if (!cand.phone && result.phone) data.phone = result.phone;
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
        if (cand?.cvFileId && cand.stage === 'APPLIED') {
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
          if (cand?.cvFileId && cand.stage === 'APPLIED' && !cand.screenedAt) {
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
        ? r.jobDescription.replace(/<[^>]+>/g, '').slice(0, 200).trim()
        : null,
      postedAt: r.createdAt.toISOString(),
    }));
  }

  async applicationStatus(email: string) {
    if (!email || email.trim().length < 5) {
      throw new BadRequestException('Please provide a valid email address');
    }
    const candidates = await this.prisma.candidate.findMany({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
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
    this.drive.shareAnyoneWithLink(uploaded.id, 'reader').catch((e) => this.logger.warn(`CV share failed for ${uploaded.id}: ${e?.message}`));
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
    await this.requireRecruitmentAccess(req.unitFactory, userId);
    return req;
  }

  /**
   * Recruitment (the CV pipeline) is restricted to Corporate HR, CHRO and super
   * users — both viewing and managing. Department Head / Factory HR / SBU Head /
   * Medical never see it.
   */
  private async requireRecruitmentAccess(unit: string, userId: string) {
    const allowed =
      (await this.permissions.hasRoleForUnitName(
        userId,
        'corporate_hr',
        unit,
      )) || (await this.permissions.hasRoleForUnitName(userId, 'chro', unit));
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can access recruitment for this requisition',
      );
    }
  }

  /** Global recruitment role check (for cross-requisition views like talent pool). */
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
        'Only Corporate HR, CHRO or a super user can view the talent pool',
      );
    }
  }

  /** Retroactively share every existing CV file as "anyone with link → reader". */
  async backfillCvSharing(userId: string) {
    await this.requireRecruitmentRole(userId);
    const candidates = await this.prisma.candidate.findMany({
      where: { cvFileId: { not: null } },
      select: { id: true, cvFileId: true },
    });
    let fixed = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        await this.drive.shareAnyoneWithLink(c.cvFileId!, 'reader');
        fixed++;
      } catch (e) {
        this.logger.warn(`Backfill share failed for candidate ${c.id} file ${c.cvFileId}: ${(e as Error)?.message}`);
        failed++;
      }
    }
    return { total: candidates.length, fixed, failed };
  }

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

function serializeCandidate(c: CandidateRow) {
  return {
    id: c.id,
    requisitionId: c.requisitionId,
    name: c.name,
    email: c.email ?? '',
    phone: c.phone ?? '',
    source: c.source,
    stage: c.stage.toLowerCase(),
    cvFileId: c.cvFileId,
    cvUrl: c.cvUrl,
    notes: c.notes ?? '',
    salaryExpectation: c.salaryExpectation ?? '',
    matchScore: c.matchScore,
    matchSummary: c.matchSummary ?? '',
    screenedAt: c.screenedAt ? c.screenedAt.toISOString() : null,
    viewedAt: c.viewedAt ? c.viewedAt.toISOString() : null,
    talentPool: c.talentPool,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
