import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';

import { PdfService } from '../../common/pdf/pdf.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
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
  RATING_LABEL,
  RATING_QUESTIONS,
  RATING_SCALE,
  buildReferenceCheckForm,
} from './reference-check-form';
import type {
  DraftReferenceCommentDto,
  ReferenceCheckDto,
} from './dto/reference-check.dto';

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
    private readonly ai: AiGraderService,
  ) {}

  /**
   * Draft question 7, "Overall comments", from what the referee has said so
   * far — the nine ratings above all, plus any answers already typed.
   *
   * Nothing is saved: the text comes back to the form, and the recruiter
   * reads and edits it as their own. It must say only what the ratings and
   * answers say — a reference is evidence, and an invented compliment on it
   * is worse than a blank.
   */
  async draftComment(
    candidateId: string,
    userId: string,
    dto: DraftReferenceCommentDto,
  ): Promise<{ comment: string }> {
    const cand = await this.requireCandidate(candidateId, userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const ratings = RATING_QUESTIONS.map((q) => {
      const v = dto.ratings?.[q.key];
      return v ? `- ${q.text}: ${RATING_LABEL[v] ?? v}` : null;
    }).filter(Boolean);
    if (ratings.length === 0) {
      throw new BadRequestException(
        'Rate the candidate in section 3 first — the comment is drafted from those answers.',
      );
    }
    const said = (label: string, v?: string) =>
      v?.trim() ? `${label}: ${v.trim()}` : null;
    const answers = [
      said('Relationship to the candidate', dto.relationship),
      said('Known for', dto.knownDuration),
      said('Strengths', dto.strengths),
      said('Weaknesses', dto.weaknesses),
      said('Handed over duties before leaving', dto.handover),
      said('Eligible for rehire', dto.rehireEligible),
      said('Disciplinary / legal concerns', dto.concerns),
    ].filter(Boolean);
    const referee = [dto.refereeName, dto.refereeDesignation, dto.refereeOrganization]
      .map((v) => v?.trim())
      .filter(Boolean)
      .join(', ');

    const prompt = `You are an HR officer at DBL Group (Bangladesh) completing a pre-employment reference check form after a phone call with a referee. Write the "Overall comments" box.

Candidate: ${cand.name}
Position applied for: ${cand.requisition.designation}
${referee ? `Referee: ${referee}\n` : ''}
The referee's ratings:
${ratings.join('\n')}
${answers.length ? `\nThe referee's other answers:\n${answers.join('\n')}\n` : ''}${
      dto.overallComments?.trim()
        ? `\nAlready written (improve it, keep its facts):\n${dto.overallComments.trim()}\n`
        : ''
    }
Write 2 to 4 plain, professional sentences in the third person ("The referee rated…", "He/She was described as…" — use the candidate's name rather than guessing a pronoun). Summarise the overall picture the ratings give, name the strongest and weakest areas, and state plainly any concern or rehire answer if one was given. Say nothing the ratings and answers do not support — no invented facts. Reply with the comment text only: no heading, no quotes, no bullet points.`;

    const raw = await this.ai.complete(prompt, 400);
    const comment = raw
      .trim()
      .replace(/^["'“]+|["'”]+$/g, '')
      .replace(/^overall comments?:\s*/i, '')
      .trim();
    if (!comment) {
      throw new ServiceUnavailableException('The AI returned nothing — try again.');
    }
    return { comment: comment.slice(0, 4000) };
  }

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
      {
        userId: cand.requisition.coverRecruiterId,
        until: cand.requisition.coverUntil,
      },
    );
    return cand;
  }
}
