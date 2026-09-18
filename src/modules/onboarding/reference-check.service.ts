import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';

import { PdfService } from '../../common/pdf/pdf.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DriveService } from '../integrations/google/drive.service';
import { contentDisposition } from '../../common/files/secure-file.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import {
  LETTERHEAD_IN_FLOW_SELECTORS,
  LETTERHEAD_PDF_MARGIN,
  letterheadFooterHtml,
  letterheadHeaderHtml,
} from './letterhead';
import {
  QUALITY_SCALE,
  RATING_QUESTIONS,
  RATING_SCALE,
  buildReferenceCheckForm,
} from './reference-check-form';
import type { ReferenceCheckDto } from './dto/reference-check.dto';

/**
 * Pre-employment reference checks.
 *
 * The recruiter fills one in per referee while they are on the call. The PDF
 * is rendered on demand rather than stored: Drive cannot replace a file in
 * place, so filing a copy on every edit would either litter the folder with
 * versions or leave a stale form in the candidate's file. The copy that goes
 * into the permanent record is written when the onboarding is archived.
 */
@Injectable()
export class ReferenceCheckService {
  private readonly logger = new Logger(ReferenceCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly pdf: PdfService,
    private readonly notifications: NotificationsService,
    private readonly drive: DriveService,
  ) {}

  async list(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const rows = await this.prisma.referenceCheck.findMany({
      where: { candidateId: cand.id },
      orderBy: { createdAt: 'asc' },
      include: { conductedBy: { select: { name: true } } },
    });
    return { items: rows.map((r) => this.serialize(r)) };
  }

  async save(
    candidateId: string,
    userId: string,
    dto: ReferenceCheckDto,
    id?: string,
  ) {
    const cand = await this.requireCandidate(candidateId, userId);
    this.assertRatings(dto.ratings);

    const data = {
      refereeName: dto.refereeName.trim(),
      refereeDesignation: dto.refereeDesignation?.trim() || null,
      refereeOrganization: dto.refereeOrganization?.trim() || null,
      refereeEmail: dto.refereeEmail?.trim() || null,
      refereePhone: dto.refereePhone?.trim() || null,
      knownDuration: dto.knownDuration?.trim() || null,
      relationship: dto.relationship?.trim() || null,
      strengths: dto.strengths?.trim() || null,
      weaknesses: dto.weaknesses?.trim() || null,
      ratings: dto.ratings ?? {},
      handover: dto.handover?.trim() || null,
      rehireEligible: dto.rehireEligible?.trim() || null,
      concerns: dto.concerns?.trim() || null,
      overallComments: dto.overallComments?.trim() || null,
    };

    if (id) {
      const existing = await this.prisma.referenceCheck.findFirst({
        where: { id, candidateId: cand.id },
      });
      if (!existing) throw new NotFoundException('Reference check not found');
      await this.prisma.referenceCheck.update({ where: { id }, data });
    } else {
      await this.prisma.referenceCheck.create({
        data: { ...data, candidateId: cand.id, conductedById: userId },
      });
    }

    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'reference_check',
    });
    return this.list(candidateId, userId);
  }

  async remove(candidateId: string, id: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const existing = await this.prisma.referenceCheck.findFirst({
      where: { id, candidateId: cand.id },
    });
    if (!existing) throw new NotFoundException('Reference check not found');
    await this.prisma.referenceCheck.delete({ where: { id } });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'reference_check',
    });
    return this.list(candidateId, userId);
  }

  /** The completed form, rendered fresh so it always matches what is on screen. */
  async streamPdf(
    candidateId: string,
    id: string,
    userId: string,
    res: Response,
  ): Promise<void> {
    const cand = await this.requireCandidate(candidateId, userId);
    const rc = await this.prisma.referenceCheck.findFirst({
      where: { id, candidateId: cand.id },
      include: {
        conductedBy: {
          select: { name: true, employeeCode: true, signatureFileId: true },
        },
      },
    });
    if (!rc) throw new NotFoundException('Reference check not found');

    const pdf = await this.render(rc, cand);
    if (!pdf) {
      throw new BadRequestException(
        'The form could not be produced just now. Please try again in a moment.',
      );
    }
    res.setHeader('Content-Type', 'application/pdf');
    // Through the shared helper: a raw name here carries an em dash and, often,
    // a Bengali referee name — neither of which may appear in a header, and
    // both of which crashed the response before it reached the browser.
    res.setHeader(
      'Content-Disposition',
      contentDisposition('inline', `Reference Check - ${rc.refereeName}.pdf`),
    );
    res.end(pdf);
  }

  /** Every reference check as a PDF, for filing at archive time. */
  async renderAllForFiling(
    candidateId: string,
  ): Promise<{ name: string; buffer: Buffer }[]> {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!cand) return [];
    const rows = await this.prisma.referenceCheck.findMany({
      where: { candidateId },
      include: {
        conductedBy: {
          select: { name: true, employeeCode: true, signatureFileId: true },
        },
      },
    });
    const out: { name: string; buffer: Buffer }[] = [];
    for (const rc of rows) {
      const pdf = await this.render(rc, cand);
      if (pdf) {
        out.push({
          name: `Reference Check — ${rc.refereeName}.pdf`,
          buffer: pdf,
        });
      }
    }
    return out;
  }

  // --- helpers -------------------------------------------------------------

  private async render(
    rc: {
      refereeName: string;
      refereeDesignation: string | null;
      refereeOrganization: string | null;
      refereeEmail: string | null;
      refereePhone: string | null;
      knownDuration: string | null;
      relationship: string | null;
      strengths: string | null;
      weaknesses: string | null;
      ratings: unknown;
      handover: string | null;
      rehireEligible: string | null;
      concerns: string | null;
      overallComments: string | null;
      conductedAt: Date;
      conductedBy: {
        name: string;
        employeeCode: string;
        signatureFileId: string | null;
      };
    },
    cand: { name: string; requisition: { designation: string } },
  ): Promise<Buffer | null> {
    const html = buildReferenceCheckForm({
      candidateName: cand.name,
      positionApplied: cand.requisition.designation,
      refereeName: rc.refereeName,
      refereeDesignation: rc.refereeDesignation,
      refereeOrganization: rc.refereeOrganization,
      refereeEmail: rc.refereeEmail,
      refereePhone: rc.refereePhone,
      knownDuration: rc.knownDuration,
      relationship: rc.relationship,
      strengths: rc.strengths,
      weaknesses: rc.weaknesses,
      ratings: (rc.ratings ?? {}) as Record<string, string>,
      handover: rc.handover,
      rehireEligible: rc.rehireEligible,
      concerns: rc.concerns,
      overallComments: rc.overallComments,
      conductedByName: rc.conductedBy.name,
      conductedByEmployeeCode: rc.conductedBy.employeeCode,
      // The recruiter's own e-signature, if they have uploaded one — the paper
      // form is signed, and this is the same signature it would carry.
      conductedBySignature: await this.signatureDataUri(
        rc.conductedBy.signatureFileId,
      ),
      conductedAt: rc.conductedAt,
    });
    return this.pdf.fromHtml(html, {
      headerHtml: letterheadHeaderHtml(),
      footerHtml: letterheadFooterHtml(),
      margin: { ...LETTERHEAD_PDF_MARGIN },
      stripSelectors: [...LETTERHEAD_IN_FLOW_SELECTORS],
    });
  }

  private async signatureDataUri(
    fileId: string | null,
  ): Promise<string | null> {
    if (!fileId) return null;
    try {
      const { buffer, mimeType } = await this.drive.getFileBuffer(fileId);
      return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (e) {
      this.logger.warn(
        `Could not read a signature for a reference check: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Refuse a rating the form does not offer.
   *
   * Question e has its own three-point scale, so "excellent" is a valid word
   * but not a valid answer to it — which a whitelist per question catches and
   * a single enum would not.
   */
  private assertRatings(ratings?: Record<string, string>) {
    if (!ratings) return;
    for (const [key, value] of Object.entries(ratings)) {
      const q = RATING_QUESTIONS.find((x) => x.key === key);
      if (!q) throw new BadRequestException(`Unknown rating "${key}"`);
      const allowed: readonly string[] =
        q.scale === QUALITY_SCALE ? QUALITY_SCALE : RATING_SCALE;
      if (value && !allowed.includes(value)) {
        throw new BadRequestException(
          `"${value}" is not one of the options for question ${q.letter}`,
        );
      }
    }
  }

  private serialize(rc: {
    id: string;
    refereeName: string;
    refereeDesignation: string | null;
    refereeOrganization: string | null;
    refereeEmail: string | null;
    refereePhone: string | null;
    knownDuration: string | null;
    relationship: string | null;
    strengths: string | null;
    weaknesses: string | null;
    ratings: unknown;
    handover: string | null;
    rehireEligible: string | null;
    concerns: string | null;
    overallComments: string | null;
    conductedAt: Date;
    conductedBy: { name: string };
  }) {
    return {
      id: rc.id,
      refereeName: rc.refereeName,
      refereeDesignation: rc.refereeDesignation,
      refereeOrganization: rc.refereeOrganization,
      refereeEmail: rc.refereeEmail,
      refereePhone: rc.refereePhone,
      knownDuration: rc.knownDuration,
      relationship: rc.relationship,
      strengths: rc.strengths,
      weaknesses: rc.weaknesses,
      ratings: (rc.ratings ?? {}) as Record<string, string>,
      handover: rc.handover,
      rehireEligible: rc.rehireEligible,
      concerns: rc.concerns,
      overallComments: rc.overallComments,
      conductedByName: rc.conductedBy.name,
      conductedAt: rc.conductedAt.toISOString(),
    };
  }

  private async requireCandidate(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.permissions.requireRecruitmentAccess(
      userId,
      cand.requisition.unitFactory,
      cand.requisition.recruiterId,
      'record reference checks',
    );
    return cand;
  }
}
