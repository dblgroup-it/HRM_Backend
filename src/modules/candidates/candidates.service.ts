import {
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
import type { RequisitionDriveMap } from '../integrations/google/google.types';
import { RecruitmentService } from './recruitment.service';
import { CreateCandidateDto, UpdateCandidateDto } from './dto/candidate.dto';

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
    private readonly recruitment: RecruitmentService,
  ) {}

  // --- workspace -----------------------------------------------------------

  async getWorkspace(reqId: string, userId: string) {
    const req = await this.requireReq(reqId, userId, 'read');
    return {
      connected: this.recruitment.driveConnected(),
      drive: (req.drive as unknown as RequisitionDriveMap | null) ?? null,
    };
  }

  async setupWorkspace(reqId: string, userId: string) {
    const req = await this.requireReq(reqId, userId, 'write');
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
    await this.requireReq(reqId, userId, 'read');
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
    const req = await this.requireReq(reqId, userId, 'write');
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
    const req = await this.requireReq(reqId, userId, 'write');

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
    await this.requireUnit(cand.requisition.unitFactory, userId, 'write');

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
    await this.requireUnit(cand.requisition.unitFactory, userId, 'write');

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
    await this.requireUnit(cand.requisition.unitFactory, userId, 'write');

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

  // --- access control ------------------------------------------------------

  private async requireReq(
    reqId: string,
    userId: string,
    mode: 'read' | 'write',
  ) {
    const req = await this.prisma.requisition.findUnique({ where: { id: reqId } });
    if (!req) throw new NotFoundException('Requisition not found');
    await this.requireUnit(req.unitFactory, userId, mode);
    return req;
  }

  private async requireUnit(
    unit: string,
    userId: string,
    mode: 'read' | 'write',
  ) {
    if (mode === 'read') {
      if (!(await this.permissions.canAccessUnitName(userId, unit))) {
        throw new ForbiddenException('You cannot access this unit');
      }
      return;
    }
    // Recruitment (CV pipeline) is Corporate HR's continuation of the flow.
    if (!(await this.permissions.hasRoleForUnitName(userId, 'corporate_hr', unit))) {
      throw new ForbiddenException(
        'Only Corporate HR can manage candidates for this requisition',
      );
    }
  }
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
