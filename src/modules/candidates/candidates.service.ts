import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CandidateStage, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { DriveService } from '../integrations/google/drive.service';
import { MailService } from '../integrations/mail/mail.service';
import type { RequisitionDriveMap } from '../integrations/google/google.types';
import { RecruitmentService } from './recruitment.service';
import {
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

@Injectable()
export class CandidatesService {
  private readonly logger = new Logger(CandidatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly drive: DriveService,
    private readonly mail: MailService,
    private readonly recruitment: RecruitmentService,
  ) {}

  // --- workspace -----------------------------------------------------------

  async getWorkspace(reqId: string, userId: string) {
    const req = await this.requireReq(reqId, userId);
    return {
      connected: this.recruitment.driveConnected(),
      mailConfigured: this.mail.isConfigured(),
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
    return { connected: true, drive };
  }

  // --- candidates ----------------------------------------------------------

  async list(reqId: string, userId: string) {
    await this.requireReq(reqId, userId);
    const rows = await this.prisma.candidate.findMany({
      where: { requisitionId: reqId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(serializeCandidate);
  }

  /**
   * Import CVs that were dropped straight into the "All CVs" Drive folder (via
   * the shared collection link) but aren't tracked as candidates yet. Idempotent
   * — matches on the Drive file id, so re-running never duplicates.
   */
  async syncFromDrive(reqId: string, userId: string) {
    const req = await this.requireReq(reqId, userId);
    const ws = await this.recruitment.ensureWorkspace(req);
    if (!ws) throw new ServiceUnavailableException('Google Drive is not connected.');

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
      this.notifications.broadcastChange('candidate', reqId, { action: 'synced' });
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
      if (!ws) throw new ServiceUnavailableException('Google Drive is not connected.');
      const uploaded = await this.drive.uploadFile(ws.allCvFolderId, {
        name: cvFileName(dto.name, file.originalname),
        mimeType: file.mimetype,
        buffer: file.buffer,
      });
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

    this.notifications.broadcastChange('candidate', reqId, { action: 'created' });
    return serializeCandidate(created);
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

    if (dto.stage) {
      const stage = dto.stage.toUpperCase() as CandidateStage;
      data.stage = stage;
      // Mirror the move in Drive: shift the CV into the stage's folder.
      const ws =
        (cand.requisition.drive as unknown as RequisitionDriveMap | null) ?? null;
      if (ws?.allCvFolderId && cand.cvFileId) {
        await this.drive.moveFile(cand.cvFileId, this.drive.stageFolderId(ws, stage));
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
    if (!ws) throw new ServiceUnavailableException('Google Drive is not connected.');
    const target = this.drive.stageFolderId(ws, cand.stage);
    const uploaded = await this.drive.uploadFile(target, {
      name: cvFileName(cand.name, file.originalname),
      mimeType: file.mimetype,
      buffer: file.buffer,
    });

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
      throw new BadRequestException('This candidate has no email address on file');
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

  // --- public job application (no auth) ------------------------------------

  async publicJobInfo(reqId: string) {
    const req = await this.prisma.requisition.findUnique({ where: { id: reqId } });
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
    const req = await this.prisma.requisition.findUnique({ where: { id: reqId } });
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
    await this.prisma.candidate.create({
      data: {
        requisitionId: reqId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone ?? null,
        source: 'application',
        cvFileId: uploaded.id,
        cvUrl: uploaded.url,
      },
    });
    this.notifications.broadcastChange('candidate', reqId, { action: 'application' });
    return { ok: true };
  }

  // --- access control ------------------------------------------------------

  private async requireReq(reqId: string, userId: string) {
    const req = await this.prisma.requisition.findUnique({ where: { id: reqId } });
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
      (await this.permissions.hasRoleForUnitName(userId, 'corporate_hr', unit)) ||
      (await this.permissions.hasRoleForUnitName(userId, 'chro', unit));
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can access recruitment for this requisition',
      );
    }
  }
}

function cvFileName(candidate: string, original: string): string {
  const dot = original.lastIndexOf('.');
  const ext = dot >= 0 ? original.slice(dot) : '';
  return `${candidate} — CV${ext}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
