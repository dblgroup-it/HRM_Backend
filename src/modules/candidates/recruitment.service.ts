import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { DriveService } from '../integrations/google/drive.service';
import type { RequisitionDriveMap } from '../integrations/google/google.types';

/** Minimal shape needed to build a requisition's Drive workspace. */
export interface RequisitionWorkspaceInput {
  id: string;
  code: string;
  designation: string;
  unitFactory: string;
  department: string;
  drive: Prisma.JsonValue | null;
}

/**
 * Owns the Google Drive folder workspace for a requisition: creates the tree on
 * demand (idempotently) and persists the resulting folder map on the requisition.
 */
@Injectable()
export class RecruitmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drive: DriveService,
  ) {}

  driveConnected(): boolean {
    return this.drive.isConfigured();
  }

  /** Return the existing workspace, or create it if Drive is connected (else null). */
  async ensureWorkspace(
    req: RequisitionWorkspaceInput,
  ): Promise<RequisitionDriveMap | null> {
    const existing =
      (req.drive as unknown as RequisitionDriveMap | null) ?? null;
    if (existing?.allCvFolderId) return existing;
    if (!this.drive.isConfigured()) return null;

    const map = await this.drive.createRequisitionTree({
      code: req.code,
      designation: req.designation,
      unit: req.unitFactory,
      department: req.department,
    });
    await this.prisma.requisition.update({
      where: { id: req.id },
      data: { drive: map as unknown as Prisma.InputJsonValue },
    });
    return map;
  }

  async ensureById(reqId: string): Promise<RequisitionDriveMap | null> {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
      select: {
        id: true,
        code: true,
        designation: true,
        unitFactory: true,
        department: true,
        drive: true,
      },
    });
    if (!req) return null;
    return this.ensureWorkspace(req);
  }
}
