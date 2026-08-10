import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingDocStatus, MedicalStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { DriveService } from '../integrations/google/drive.service';
import { MailService } from '../integrations/mail/mail.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import { RecruitmentService } from '../candidates/recruitment.service';
import { MedicalDto, NotifyItDto } from './dto/onboarding.dto';

/** Role keys allowed to record medical clearance (configurable / either name). */
export const MEDICAL_ROLE_KEYS = ['medical_officer', 'medical_team'];

/** The standard joining-document checklist shown to a selected candidate. */
export const REQUIRED_DOCS = [
  'National ID / Passport',
  'Academic Certificates',
  'Experience / Release Letter',
  'Address Proof',
  'Passport-size Photo',
];

/** Multer file subset we use for document uploads. */
export interface UploadedDoc {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

type OnboardingWithDocs = Prisma.OnboardingGetPayload<{
  include: { docs: true };
}>;

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly drive: DriveService,
    private readonly mail: MailService,
    private readonly ai: AiGraderService,
    private readonly recruitment: RecruitmentService,
    private readonly config: ConfigService,
  ) {}

  // --- HR: lifecycle -------------------------------------------------------

  /** Start (or return) onboarding for a selected candidate. */
  async start(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const existing = await this.prisma.onboarding.findUnique({
      where: { candidateId },
    });
    if (!existing) {
      await this.prisma.onboarding.create({
        data: { candidateId, token: randomBytes(18).toString('hex') },
      });
      this.notifications.broadcastChange('candidate', cand.requisitionId, {
        action: 'onboarding_started',
      });
    }
    return this.getByCandidate(candidateId, userId);
  }

  async getByCandidate(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.prisma.onboarding.findUnique({
      where: { candidateId },
      include: { docs: { orderBy: { createdAt: 'asc' } } },
    });
    return {
      aiConfigured: this.ai.isConfigured(),
      aiProvider: this.ai.provider,
      mailConfigured: this.mail.isConfigured(),
      itWebhook: Boolean(this.config.get<string>('it.webhookUrl')),
      requiredDocs: REQUIRED_DOCS,
      candidate: {
        id: cand.id,
        name: cand.name,
        email: cand.email ?? '',
        phone: cand.phone ?? '',
        stage: cand.stage.toLowerCase(),
        source: cand.source,
        matchScore: cand.matchScore,
        matchSummary: cand.matchSummary ?? '',
        requisitionId: cand.requisitionId,
        designation: cand.requisition.designation,
        code: cand.requisition.code,
        unit: cand.requisition.unitFactory,
        department: cand.requisition.department,
      },
      onboarding: ob ? this.serialize(ob, cand.name, cand.email) : null,
    };
  }

  /** Email the candidate the secure document-submission link. */
  async sendLink(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    if (!cand.email) {
      throw new BadRequestException(
        'This candidate has no email address on file',
      );
    }
    const link = this.publicLink(ob.token);
    await this.mail.send({
      to: cand.email,
      subject: `Joining documents — ${cand.requisition.designation} | DBL Group`,
      text: `Dear ${cand.name},\n\nCongratulations on being selected for the position of ${cand.requisition.designation} at DBL Group.\n\nPlease upload your joining documents securely using the link below:\n\n${link}\n\nWarm regards,\nDBL Group Recruitment`,
      html: this.emailHtml(
        `Dear ${cand.name},<br><br>Congratulations on being selected for the position of <b>${cand.requisition.designation}</b> at DBL Group.<br><br>Please upload your joining documents securely using the button below.`,
        { label: 'Upload your documents', url: link },
      ),
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'onboarding_link_sent',
    });
    return this.getByCandidate(candidateId, userId);
  }

  // --- HR: document verification (Stage B) ---------------------------------

  /** Run AI OCR + field extraction on one submitted document. */
  async summarizeDoc(docId: string, userId: string) {
    const doc = await this.loadDoc(docId);
    await this.requireCandidate(doc.onboarding.candidateId, userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI extraction is not configured');
    }
    const { buffer, mimeType } = await this.drive.getFileBuffer(doc.fileId);
    const result = await this.ai.extractDocument({
      label: doc.label,
      mimeType: doc.mimeType || mimeType,
      base64: buffer.toString('base64'),
    });
    await this.prisma.onboardingDoc.update({
      where: { id: docId },
      data: { aiExtract: result as unknown as Prisma.InputJsonValue },
    });
    this.notifications.broadcastChange(
      'candidate',
      doc.onboarding.candidate.requisitionId,
      { action: 'doc_summarized' },
    );
    return this.getByCandidate(doc.onboarding.candidateId, userId);
  }

  async verifyDoc(docId: string, status: OnboardingDocStatus, userId: string) {
    const doc = await this.loadDoc(docId);
    await this.requireCandidate(doc.onboarding.candidateId, userId);
    await this.prisma.onboardingDoc.update({
      where: { id: docId },
      data: { status },
    });
    this.notifications.broadcastChange(
      'candidate',
      doc.onboarding.candidate.requisitionId,
      { action: 'doc_verified' },
    );
    return this.getByCandidate(doc.onboarding.candidateId, userId);
  }

  /**
   * AI cross-verification: check every extracted document against the
   * candidate's profile and against each other; store the findings.
   */
  async crossVerify(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.prisma.onboarding.findUnique({
      where: { candidateId },
      include: { docs: { orderBy: { createdAt: 'asc' } } },
    });
    if (!ob)
      throw new BadRequestException(
        'Start onboarding for this candidate first',
      );
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException(
        'AI cross-verification is not configured',
      );
    }
    const extracted = ob.docs.filter((d) => d.aiExtract);
    if (!extracted.length) {
      throw new BadRequestException(
        'Run AI extraction on at least one document first',
      );
    }
    const result = await this.ai.crossCheckDocuments({
      candidate: { name: cand.name, email: cand.email, phone: cand.phone },
      role: {
        designation: cand.requisition.designation,
        education: cand.requisition.education,
        experience: cand.requisition.experience,
      },
      docs: extracted.map((d) => {
        const ex = d.aiExtract as {
          summary?: string;
          fields?: Record<string, string>;
        };
        return {
          label: d.label,
          summary: ex.summary ?? '',
          fields: ex.fields ?? {},
        };
      }),
    });
    await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: {
        crossCheck: result as unknown as Prisma.InputJsonValue,
        crossCheckedAt: new Date(),
      },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'cross_checked',
    });
    return this.getByCandidate(candidateId, userId);
  }

  // --- HR: offer (Stage C) -------------------------------------------------

  async sendOffer(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    if (!cand.email) {
      throw new BadRequestException(
        'This candidate has no email address on file',
      );
    }
    const link = this.publicLink(ob.token);
    await this.mail.send({
      to: cand.email,
      subject: `Offer of employment — ${cand.requisition.designation} | DBL Group`,
      text: `Dear ${cand.name},\n\nWe are pleased to offer you the position of ${cand.requisition.designation} at ${cand.requisition.unitFactory}, DBL Group.\n\nPlease review and accept your offer here:\n\n${link}\n\nWarm regards,\nDBL Group Recruitment`,
      html: this.emailHtml(
        `Dear ${cand.name},<br><br>We are delighted to offer you the position of <b>${cand.requisition.designation}</b> at <b>${cand.requisition.unitFactory}</b>, DBL Group.<br><br>Please review and accept your offer using the button below.`,
        { label: 'Review & accept offer', url: link },
      ),
    });
    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { offerSentAt: new Date(), status: 'offer_sent' },
      include: { docs: { orderBy: { createdAt: 'asc' } } },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'offer_sent',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  // --- HR: final verify + archive (Stage D) --------------------------------

  async hrVerify(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    if (ob.medicalStatus !== 'cleared') {
      throw new BadRequestException(
        'Medical clearance is required before HR final verification',
      );
    }
    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { hrVerifiedAt: new Date(), status: 'hr_final' },
      include: { docs: { orderBy: { createdAt: 'asc' } } },
    });
    // Auto-reject all remaining applied candidates for this requisition.
    await this.prisma.candidate.updateMany({
      where: { requisitionId: cand.requisitionId, stage: 'APPLIED' },
      data: { stage: 'REJECTED' },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'hr_verified',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  /**
   * Archive the joining documents: physically move the candidate's Drive
   * folder to "DBL HRM Recruitment / 00 Archive / {REQ} — {designation}" and
   * stamp the onboarding. Drive trouble degrades to a flag-only archive.
   */
  async archive(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);

    let archiveFolderUrl: string | null = ob.archiveFolderUrl;
    if (!archiveFolderUrl) {
      try {
        const ws = await this.recruitment.ensureWorkspace(cand.requisition);
        if (ws) {
          const rootId = await this.drive.ensureRootFolder();
          const archiveRoot = await this.drive.ensureFolder(
            '00 Archive',
            rootId,
          );
          const reqArchive = await this.drive.ensureFolder(
            `${cand.requisition.code} — ${cand.requisition.designation}`,
            archiveRoot,
          );
          const candFolder = await this.drive.ensureFolder(
            `${cand.name} — Joining Docs`,
            ws.joiningFolderId,
          );
          await this.drive.moveFile(candFolder, reqArchive);
          archiveFolderUrl = `https://drive.google.com/drive/folders/${candFolder}`;
        }
      } catch (err) {
        this.logger.warn(
          `Drive archive failed (flag-only archive): ${(err as Error).message}`,
        );
      }
    }

    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { archivedAt: new Date(), archiveFolderUrl },
      include: { docs: { orderBy: { createdAt: 'asc' } } },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'archived',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  /** Step 24 — hand off to IT (webhook), write back the issued email + asset id. */
  async notifyIt(candidateId: string, dto: NotifyItDto, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    // Guard the state machine: IT hand-off is the final step — HR final
    // verification (which itself requires medical clearance) must be done first.
    if (!ob.hrVerifiedAt) {
      throw new BadRequestException(
        'Complete HR final verification before notifying IT',
      );
    }

    let email = dto.email?.trim() || null;
    let assetId = dto.assetId?.trim() || null;

    const webhookUrl = this.config.get<string>('it.webhookUrl');
    if (webhookUrl) {
      try {
        const payload = {
          employee_id: cand.id,
          name: cand.name,
          role: cand.requisition.designation,
          unit: cand.requisition.unitFactory,
          department: cand.requisition.department,
          location: cand.requisition.placeOfPosting,
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            email?: string;
            asset_id?: string;
            assetId?: string;
          };
          email = data.email ?? email;
          assetId = data.asset_id ?? data.assetId ?? assetId;
        } else {
          this.logger.warn(`IT webhook returned ${res.status}`);
        }
      } catch (err) {
        this.logger.warn(`IT webhook failed: ${(err as Error).message}`);
      }
    }

    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: {
        itEmail: email,
        itAssetId: assetId,
        itNotifiedAt: new Date(),
        status: 'onboarded',
      },
      include: { docs: { orderBy: { createdAt: 'asc' } } },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'it_notified',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  // --- Medical officer (Stage D) -------------------------------------------

  /**
   * Onboardings awaiting medical clearance. Any medical-role holder (or super
   * user) sees the whole pending queue — clearance is a central function, and
   * scoping by unit name is unreliable given ZingHR vs. configured name drift.
   */
  async medicalQueue(userId: string) {
    await this.requireMedicalRole(userId);
    const rows = await this.prisma.onboarding.findMany({
      where: {
        offerAcceptedAt: { not: null },
        medicalStatus: 'pending',
      },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        candidate: {
          include: {
            requisition: {
              select: {
                designation: true,
                unitFactory: true,
                department: true,
                placeOfPosting: true,
              },
            },
          },
        },
      },
      orderBy: { offerAcceptedAt: 'asc' },
    });
    return rows.map((r) => ({
      ...this.serialize(r, r.candidate.name, r.candidate.email),
      candidate: {
        id: r.candidate.id,
        name: r.candidate.name,
        email: r.candidate.email ?? '',
        designation: r.candidate.requisition.designation,
        unit: r.candidate.requisition.unitFactory,
        department: r.candidate.requisition.department,
        location: r.candidate.requisition.placeOfPosting,
      },
    }));
  }

  async setMedical(onboardingId: string, dto: MedicalDto, userId: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');
    await this.requireMedicalRole(userId);

    await this.prisma.onboarding.update({
      where: { id: onboardingId },
      data: {
        medicalStatus: dto.status,
        medicalNote: dto.note ?? null,
        medicalClearedAt: dto.status === 'cleared' ? new Date() : null,
        status: ob.status === 'offer_accepted' ? 'medical' : ob.status,
      },
    });

    // Tell Corporate HR the candidate cleared (or didn't).
    const hrIds = await this.permissions.roleHolderUserIds(
      'corporate_hr',
      ob.candidate.requisition.unitFactory,
    );
    await this.notifications.notifyMany(hrIds, {
      type: 'onboarding',
      title: `Medical ${dto.status}`,
      message: `${ob.candidate.name} (${ob.candidate.requisition.designation}) medical is ${dto.status}.`,
      link: `/requisitions/${ob.candidate.requisitionId}`,
    });
    this.notifications.broadcastChange(
      'candidate',
      ob.candidate.requisitionId,
      {
        action: 'medical_updated',
      },
    );
    return { ok: true };
  }

  // --- Public (candidate, by token) ----------------------------------------

  async publicGet(token: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { token },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        candidate: {
          include: {
            requisition: {
              select: { code: true, designation: true, unitFactory: true },
            },
          },
        },
      },
    });
    if (!ob) throw new NotFoundException('This link is not valid');
    return {
      candidateName: ob.candidate.name,
      code: ob.candidate.requisition.code,
      designation: ob.candidate.requisition.designation,
      unit: ob.candidate.requisition.unitFactory,
      status: ob.status,
      requiredDocs: REQUIRED_DOCS,
      offerSentAt: ob.offerSentAt?.toISOString() ?? null,
      offerAcceptedAt: ob.offerAcceptedAt?.toISOString() ?? null,
      submitted: ob.docs.map((d) => ({
        id: d.id,
        label: d.label,
        status: d.status,
      })),
    };
  }

  async publicUpload(token: string, label: string, file?: UploadedDoc) {
    if (!file) throw new BadRequestException('Please attach a file');
    if (!label?.trim()) throw new BadRequestException('Missing document label');
    const ob = await this.prisma.onboarding.findUnique({
      where: { token },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('This link is not valid');

    const ws = await this.recruitment.ensureWorkspace(ob.candidate.requisition);
    if (!ws) {
      throw new ServiceUnavailableException(
        'Document upload is temporarily unavailable. Please try again later.',
      );
    }
    const folder = await this.drive.ensureFolder(
      `${ob.candidate.name} — Joining Docs`,
      ws.joiningFolderId,
    );
    const uploaded = await this.drive.uploadFile(folder, {
      name: `${label} — ${file.originalname}`,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    const createdDoc = await this.prisma.onboardingDoc.create({
      data: {
        onboardingId: ob.id,
        label,
        fileId: uploaded.id,
        url: uploaded.url,
        mimeType: file.mimetype,
      },
    });
    // Auto-extract (OCR + structure) the doc in the background using the bytes
    // we already have in memory — no Drive re-fetch needed.
    this.autoSummarizeDoc(
      createdDoc.id,
      ob.candidate.requisitionId,
      file.buffer,
      file.mimetype,
    );
    if (ob.status === 'docs_pending') {
      await this.prisma.onboarding.update({
        where: { id: ob.id },
        data: { status: 'docs_submitted' },
      });
    }
    // Nudge Corporate HR that a document came in.
    const hrIds = await this.permissions.roleHolderUserIds(
      'corporate_hr',
      ob.candidate.requisition.unitFactory,
    );
    await this.notifications.notifyMany(hrIds, {
      type: 'onboarding',
      title: 'Document submitted',
      message: `${ob.candidate.name} uploaded "${label}".`,
      link: `/requisitions/${ob.candidate.requisitionId}`,
    });
    this.notifications.broadcastChange(
      'candidate',
      ob.candidate.requisitionId,
      {
        action: 'doc_submitted',
      },
    );
    return { ok: true };
  }

  async publicAcceptOffer(token: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { token },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('This link is not valid');
    if (!ob.offerSentAt)
      throw new BadRequestException('No offer has been sent yet');
    if (!ob.offerAcceptedAt) {
      await this.prisma.onboarding.update({
        where: { id: ob.id },
        data: { offerAcceptedAt: new Date(), status: 'offer_accepted' },
      });
      // Offer accepted → notify Corporate HR + medical officers (triggers medical).
      const unit = ob.candidate.requisition.unitFactory;
      const hrIds = await this.permissions.roleHolderUserIds(
        'corporate_hr',
        unit,
      );
      const medIds = (
        await Promise.all(
          MEDICAL_ROLE_KEYS.map((k) =>
            this.permissions.roleHolderUserIds(k, unit),
          ),
        )
      ).flat();
      await this.notifications.notifyMany(hrIds, {
        type: 'onboarding',
        title: 'Offer accepted',
        message: `${ob.candidate.name} accepted the offer for ${ob.candidate.requisition.designation}.`,
        link: `/requisitions/${ob.candidate.requisitionId}`,
      });
      await this.notifications.notifyMany(medIds, {
        type: 'onboarding',
        title: 'Medical clearance needed',
        message: `${ob.candidate.name} accepted their offer — please schedule medical clearance.`,
        link: `/medical`,
      });
      this.notifications.broadcastChange(
        'candidate',
        ob.candidate.requisitionId,
        {
          action: 'offer_accepted',
        },
      );
    }
    return { ok: true };
  }

  // --- helpers -------------------------------------------------------------

  private publicLink(token: string): string {
    const origin = this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';
    return `${origin}/onboarding/${token}`;
  }

  private async requireCandidate(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);
    return cand;
  }

  private async requireOnboarding(candidateId: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { candidateId },
    });
    if (!ob)
      throw new BadRequestException(
        'Start onboarding for this candidate first',
      );
    return ob;
  }

  /** Fire-and-forget AI extraction right after a candidate uploads a document. */
  private autoSummarizeDoc(
    docId: string,
    reqId: string,
    buffer: Buffer,
    mimeType: string,
  ): void {
    if (!this.ai.isConfigured()) return;
    void (async () => {
      try {
        const doc = await this.prisma.onboardingDoc.findUnique({
          where: { id: docId },
        });
        if (!doc) return;
        const result = await this.ai.extractDocument({
          label: doc.label,
          mimeType: mimeType || doc.mimeType,
          base64: buffer.toString('base64'),
        });
        await this.prisma.onboardingDoc.update({
          where: { id: docId },
          data: { aiExtract: result as unknown as Prisma.InputJsonValue },
        });
        this.notifications.broadcastChange('candidate', reqId, {
          action: 'doc_summarized',
        });
        // Once every submitted doc is extracted, cross-check them automatically.
        await this.autoCrossCheck(doc.onboardingId, reqId);
      } catch (err) {
        this.logger.warn(`Auto doc-summary failed: ${(err as Error).message}`);
      }
    })();
  }

  /**
   * Fire the AI cross-verification when all of an onboarding's documents have
   * been extracted; alerts Corporate HR if real discrepancies are found.
   */
  private async autoCrossCheck(onboardingId: string, reqId: string) {
    try {
      const ob = await this.prisma.onboarding.findUnique({
        where: { id: onboardingId },
        include: {
          docs: true,
          candidate: { include: { requisition: true } },
        },
      });
      if (!ob || !ob.docs.length) return;
      if (ob.docs.some((d) => !d.aiExtract)) return; // still extracting others
      const result = await this.ai.crossCheckDocuments({
        candidate: {
          name: ob.candidate.name,
          email: ob.candidate.email,
          phone: ob.candidate.phone,
        },
        role: {
          designation: ob.candidate.requisition.designation,
          education: ob.candidate.requisition.education,
          experience: ob.candidate.requisition.experience,
        },
        docs: ob.docs.map((d) => {
          const ex = d.aiExtract as {
            summary?: string;
            fields?: Record<string, string>;
          };
          return {
            label: d.label,
            summary: ex?.summary ?? '',
            fields: ex?.fields ?? {},
          };
        }),
      });
      await this.prisma.onboarding.update({
        where: { id: onboardingId },
        data: {
          crossCheck: result as unknown as Prisma.InputJsonValue,
          crossCheckedAt: new Date(),
        },
      });
      if (result.verdict === 'discrepancies') {
        const hrIds = await this.permissions.roleHolderUserIds(
          'corporate_hr',
          ob.candidate.requisition.unitFactory,
        );
        await this.notifications.notifyMany(hrIds, {
          type: 'onboarding',
          title: 'Document discrepancies flagged',
          message: `AI cross-check found discrepancies in ${ob.candidate.name}'s joining documents — please review.`,
          link: `/requisitions/${ob.candidate.requisitionId}`,
        });
      }
      this.notifications.broadcastChange('candidate', reqId, {
        action: 'cross_checked',
      });
    } catch (err) {
      this.logger.warn(`Auto cross-check failed: ${(err as Error).message}`);
    }
  }

  private async loadDoc(docId: string) {
    const doc = await this.prisma.onboardingDoc.findUnique({
      where: { id: docId },
      include: { onboarding: { include: { candidate: true } } },
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  private async requireRecruitmentAccess(unit: string, userId: string) {
    const allowed =
      (await this.permissions.hasRoleForUnitName(
        userId,
        'corporate_hr',
        unit,
      )) || (await this.permissions.hasRoleForUnitName(userId, 'chro', unit));
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can manage onboarding',
      );
    }
  }

  /** Is the user a medical officer / team member anywhere (or a super user)? */
  private async requireMedicalRole(userId: string) {
    const ok =
      (await this.permissions.isSuperUser(userId)) ||
      Boolean(
        await this.prisma.roleAssignment.findFirst({
          where: { userId, role: { key: { in: MEDICAL_ROLE_KEYS } } },
        }),
      );
    if (!ok) {
      throw new ForbiddenException(
        'Only a medical officer / team member or super user can access medical clearance',
      );
    }
  }

  private serialize(
    ob: OnboardingWithDocs,
    candidateName: string,
    candidateEmail: string | null,
  ) {
    return {
      id: ob.id,
      candidateId: ob.candidateId,
      candidateName,
      candidateEmail: candidateEmail ?? '',
      token: ob.token,
      submissionLink: this.publicLink(ob.token),
      status: ob.status,
      offerSentAt: ob.offerSentAt?.toISOString() ?? null,
      offerAcceptedAt: ob.offerAcceptedAt?.toISOString() ?? null,
      medicalStatus: ob.medicalStatus,
      medicalNote: ob.medicalNote ?? '',
      medicalClearedAt: ob.medicalClearedAt?.toISOString() ?? null,
      hrVerifiedAt: ob.hrVerifiedAt?.toISOString() ?? null,
      crossCheck: ob.crossCheck as {
        verdict?: string;
        overview?: string;
        findings?: { doc: string; severity: string; detail: string }[];
      } | null,
      crossCheckedAt: ob.crossCheckedAt?.toISOString() ?? null,
      archivedAt: ob.archivedAt?.toISOString() ?? null,
      archiveFolderUrl: ob.archiveFolderUrl ?? null,
      itEmail: ob.itEmail ?? '',
      itAssetId: ob.itAssetId ?? '',
      itNotifiedAt: ob.itNotifiedAt?.toISOString() ?? null,
      docs: ob.docs.map((d) => ({
        id: d.id,
        label: d.label,
        url: d.url,
        mimeType: d.mimeType,
        status: d.status,
        aiExtract: d.aiExtract as {
          summary?: string;
          fields?: Record<string, string>;
        } | null,
        createdAt: d.createdAt.toISOString(),
      })),
      createdAt: ob.createdAt.toISOString(),
      updatedAt: ob.updatedAt.toISOString(),
    };
  }

  private emailHtml(
    bodyHtml: string,
    cta?: { label: string; url: string },
  ): string {
    const button = cta
      ? `<tr><td style="padding:8px 28px 28px"><a href="${cta.url}" style="display:inline-block;background:#1877c0;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:bold">${cta.label}</a></td></tr>
         <tr><td style="padding:0 28px 28px;font-size:12px;color:#94a3b8">Or paste this link into your browser:<br><span style="color:#64748b">${cta.url}</span></td></tr>`
      : '';
    return `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
          <tr><td style="background:#1877c0;padding:18px 28px;color:#fff;font-size:18px;font-weight:bold">DBL Group — Recruitment</td></tr>
          <tr><td style="padding:28px 28px 16px;font-size:14px;line-height:1.7;color:#334155">${bodyHtml}</td></tr>
          ${button}
          <tr><td style="padding:18px 28px;background:#f8fafc;color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0">This message was sent by DBL Group Recruitment. Please do not share this link.</td></tr>
        </table>
      </td></tr></table>
    </body></html>`;
  }
}
