import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { tokenLookupWhere } from '../../common/crypto/action-token';
import { ConfigService } from '@nestjs/config';
import { OnboardingDocStatus, MedicalExam, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import type { Response } from 'express';

import { FileGrantService } from '../../common/files/file-grant.service';
import { SecureFileService } from '../../common/files/secure-file.service';
import { PdfService } from '../../common/pdf/pdf.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import {
  buildAppointmentLetter,
  buildOfferLetter,
  type LetterFormat,
  type LetterInput,
} from './letters';
import { buildOfferEmail, offerEmailHtml, offerEmailText } from './offer-email';
import { hrVerifyBlocker, missingDocs, pendingDocs } from './hr-verify';
import { buildCocForm } from './coc-form';
import { signatureRatioError } from '../../common/signature.util';
import { imageSize } from '../../common/upload/image-size';
import {
  LETTERHEAD_IN_FLOW_SELECTORS,
  LETTERHEAD_PDF_MARGIN,
  letterheadFooterHtml,
  letterheadHeaderHtml,
} from './letterhead';
import { NotificationsService } from '../realtime/notifications.service';
import { DriveService } from '../integrations/google/drive.service';
import { MailService } from '../integrations/mail/mail.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import { RecruitmentService } from '../candidates/recruitment.service';
import {
  ManualCrossCheckDto,
  MedicalDto,
  MedicalExamDto,
  NotifyItDto,
  OfferLetterDto,
  AppointmentLetterDto,
  SendMedicalLetterDto,
} from './dto/onboarding.dto';
import type { CvProfile } from '../candidates/cv/cv-profile.types';
import {
  bandFromDateOfBirth,
  buildCandidateMedicalEmail,
  buildMedicalTestLetter,
  MEDICAL_TEST_VENUE,
  type MedicalAgeBand,
} from './medical-test-letter';
import {
  applyCmoDecision,
  decisionNoteError,
  submissionBlocker,
  type CmoDecision,
  type ProposedMedical,
} from './medical-approval';

/** Role keys allowed to record medical clearance (configurable / either name). */
export const MEDICAL_ROLE_KEYS = ['medical_officer', 'medical_team'];

/**
 * The second pair of eyes on every medical finding.
 *
 * Global: one CMO reviews the whole group. Holding it does NOT imply the
 * examining role — a CMO confirms findings, they do not record them, and
 * letting one person do both would collapse the layer back into one signature.
 */
export const CENTRAL_MEDICAL_ROLE_KEY = 'central_medical_officer';

/**
 * When a candidate's medical is actually due.
 *
 * This used to be "the offer has been accepted", which was right while the
 * offer preceded medical. The chain now runs verify -> medical -> board
 * approval -> offer, so that condition can never hold at the moment medical
 * is due and the medical team's queue was permanently empty. It now matches
 * the step the onboarding page unlocks: documents settled, one way or the
 * other. Combine with `medicalStatus: 'pending'` at the call site.
 */
export const MEDICAL_DUE: Prisma.OnboardingWhereInput = {
  AND: [
    // Collected, or HR said there is nothing to collect.
    { OR: [{ docs: { some: {} } }, { docsSkippedAt: { not: null } }] },
    // Every collected document verified, or verification explicitly skipped.
    {
      OR: [
        { verificationSkippedAt: { not: null } },
        { docs: { some: {}, every: { status: 'verified' } } },
      ],
    },
  ],
};

/** The standard joining-document checklist shown to a selected candidate. */
/** The signed Code of Conduct, filed like any other joining document. */
export const COC_DOC_LABEL = 'Code of Conduct (signed)';

export const REQUIRED_DOCS = [
  'National ID / Passport',
  'Academic Certificates / Marksheet',
  'Experience / Release Letter',
  'Address Proof',
  'Passport-size Photo',
];

/**
 * Documents a candidate provides if they have them.
 *
 * Deliberately a separate list rather than more entries in REQUIRED_DOCS.
 * Progress, the "all uploaded" flag and the gate that opens the medical step
 * all count the required list, so an optional document added there would mean
 * nobody could ever reach complete — a fresh graduate has no pay slip, and the
 * checklist would sit at 5 of 7 forever with nothing anyone could do about it.
 *
 * They are uploaded, stored and verified exactly like the rest; they simply do
 * not hold anything up by being absent.
 */
export const OPTIONAL_DOCS = ['Pay Slip / Salary Certificate'];

/** Multer file subset we use for document uploads. */
export interface UploadedDoc {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/**
 * Fields on MedicalExam that must be filled in before a candidate can be
 * cleared — mirrors DBL's paper "Medical Fitness Report" field-for-field.
 * dutyPosition/refNo/registrationNo/familyHistoryDetail/remarks stay
 * optional (the paper form itself often leaves them blank).
 */
const REQUIRED_MEDICAL_EXAM_FIELDS: {
  key: keyof MedicalExamValues;
  label: string;
}[] = [
  { key: 'dateOfBirth', label: 'Date of Birth' },
  { key: 'examDate', label: 'Date of Examination' },
  { key: 'issueDate', label: 'Date of Issue' },
  { key: 'consultantName', label: 'Consultant Name' },
  { key: 'height', label: 'Height' },
  { key: 'weight', label: 'Weight' },
  { key: 'pulse', label: 'Pulse' },
  { key: 'bloodPressure', label: 'Blood Pressure' },
  { key: 'visionRightEye', label: 'Visual Acuity (Right Eye)' },
  { key: 'visionLeftEye', label: 'Visual Acuity (Left Eye)' },
  { key: 'visionWithGlass', label: 'Visual Acuity (with/without glass)' },
  { key: 'colorVisionYellow', label: 'Color Vision (Yellow)' },
  { key: 'colorVisionRed', label: 'Color Vision (Red)' },
  { key: 'colorVisionGreen', label: 'Color Vision (Green)' },
  { key: 'colorVisionBlue', label: 'Color Vision (Blue)' },
  { key: 'hearingRightEar', label: 'Hearing (Right Ear)' },
  { key: 'hearingLeftEar', label: 'Hearing (Left Ear)' },
  { key: 'speech', label: 'Speech' },
  { key: 'extremities', label: 'Extremities' },
  {
    key: 'noAnemiaJaundiceEtc',
    label:
      'Anemia / Jaundice / Clubbing / Koilonychia / Congenital Malformations',
  },
  {
    key: 'stableNormotensiveNondiabetic',
    label: 'Physical & Mental Stability / Normotensive / Nondiabetic',
  },
  { key: 'urineTestClear', label: 'Urine Test (Sugar / Albumin)' },
  { key: 'hepatitisBNegative', label: 'Hepatitis B (Negative)' },
  { key: 'liverFunctionNormal', label: 'Liver Function (Normal)' },
  { key: 'pastIllnessHistory', label: 'History of Past Illness' },
  { key: 'familyHistoryDmHtn', label: 'Family History (DM, HTN)' },
  { key: 'bloodGroup', label: 'Blood Group' },
  { key: 'fitToJoin', label: 'Fit to Join Determination' },
];

type MedicalExamValues = Omit<
  MedicalExam,
  'id' | 'onboardingId' | 'createdAt' | 'updatedAt'
>;

type OnboardingWithDocs = Prisma.OnboardingGetPayload<{
  include: { docs: true };
}> & {
  /** Present only where the query includes it. */
  medicalClearedBy?: { name: string } | null;
};

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
    private readonly files: FileGrantService,
    private readonly secureFiles: SecureFileService,
    private readonly pdf: PdfService,
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
        // STAGED: still stored raw — the link is re-displayed and re-sent,
        // so it must remain reconstructible. See FINAL_GO_LIVE_GATE.md.
        data: { candidateId, token: randomBytes(18).toString('hex') },
      });
      this.notifications.broadcastChange('candidate', cand.requisitionId, {
        action: 'onboarding_started',
      });
    }
    return this.getByCandidate(candidateId, userId);
  }

  /**
   * Settle which level this candidate is hired at.
   *
   * Its own action rather than a side effect of rendering a letter: the choice
   * changes what every screen calls this person, so it has to take effect when
   * it is made, not when somebody happens to open the offer letter.
   */
  async setFixedDesignation(
    candidateId: string,
    userId: string,
    designation: string | null,
  ) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    await this.resolveFixedDesignation(cand, ob, designation);
    return this.getByCandidate(candidateId, userId);
  }

  async getByCandidate(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.prisma.onboarding.findUnique({
      where: { candidateId },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
    });
    return {
      aiConfigured: this.ai.isConfigured(),
      aiProvider: this.ai.provider,
      mailConfigured: this.mail.isConfigured(),
      itWebhook: Boolean(this.config.get<string>('it.webhookUrl')),
      requiredDocs: REQUIRED_DOCS,
      optionalDocs: OPTIONAL_DOCS,
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
        /**
         * The designation to SHOW for this candidate.
         *
         * Once a level has been settled it is the one that matters — the
         * sidebar, the header card and anything else reading this field must
         * say what the letter says, not what the requisition was raised as.
         * Falls back to the requisition's primary, which is every candidate on
         * a single-level requisition.
         */
        designation: ob?.fixedDesignation ?? cand.requisition.designation,
        /**
         * The requisition's own primary, kept separate so the picker can offer
         * the full list. Deriving it from `designation` would drop the primary
         * from the choices the moment an alternate was selected.
         */
        requisitionDesignation: cand.requisition.designation,
        /** Other levels this requisition was raised for. */
        alternateDesignations: cand.requisition.alternateDesignations ?? [],
        /** The level settled for this person; null until chosen. */
        fixedDesignation: ob?.fixedDesignation ?? null,
        code: cand.requisition.code,
        unit: cand.requisition.unitFactory,
        department: cand.requisition.department,
        proposedSalary:
          cand.salaryFixation?.status === 'fixed'
            ? cand.salaryFixation.proposedSalary
            : null,
        salaryJobGrade:
          cand.salaryFixation?.status === 'fixed'
            ? cand.salaryFixation.jobGrade
            : null,
        facilities: cand.requisition.facilities ?? null,
        // Lifted out of the facilities blob, as the requisition serializer
        // does, so the panel renders the same on both pages.
        specialNotes: Array.isArray(
          (cand.requisition.facilities as { specialNotes?: unknown } | null)
            ?.specialNotes,
        )
          ? (cand.requisition.facilities as { specialNotes: string[] })
              .specialNotes
          : [],
        /** Lets the UI gate provisioning on the assigned recruiter, matching
         *  the access rule the API already enforces. */
        recruiterId: cand.requisition.recruiterId ?? null,
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
    const link = this.publicLink(ob.token ?? '');
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

  /** HR skips waiting for the candidate to submit documents (e.g. already have physical copies). */
  async skipDocs(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { docsSkippedAt: new Date() },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
    });
    await this.notifyMedicalTeamIfDue(ob.id);
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'docs_skipped',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  /** HR skips individually verifying every submitted document. */
  async skipVerification(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { verificationSkippedAt: new Date() },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
    });
    await this.notifyMedicalTeamIfDue(ob.id);
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'verification_skipped',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  async verifyDoc(docId: string, status: OnboardingDocStatus, userId: string) {
    const doc = await this.loadDoc(docId);
    await this.requireCandidate(doc.onboarding.candidateId, userId);
    await this.prisma.onboardingDoc.update({
      where: { id: docId },
      data: { status },
    });
    // The last document verified is what puts the candidate in front of the
    // medical team.
    await this.notifyMedicalTeamIfDue(doc.onboarding.id);
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
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
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

  /** Manual alternative to AI cross-verification — HR records their own verdict, no AI required. */
  async manualCrossCheck(
    candidateId: string,
    dto: ManualCrossCheckDto,
    actor: { id: string; name: string },
  ) {
    const cand = await this.requireCandidate(candidateId, actor.id);
    const ob = await this.requireOnboarding(candidateId);

    const result = {
      verdict: dto.verdict,
      overview:
        dto.note?.trim() || 'Manually reviewed by HR — no automated check run.',
      findings: [] as unknown[],
      source: 'manual',
      reviewedBy: actor.name,
    };
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
    return this.getByCandidate(candidateId, actor.id);
  }

  // --- HR: offer (Stage C) -------------------------------------------------

  /**
   * Render the offer letter without sending it, so HR can read it first.
   *
   * Takes the draft terms rather than the stored ones: the preview has to
   * reflect what is on screen, including edits not yet saved.
   */
  async previewOfferLetter(
    candidateId: string,
    userId: string,
    dto: OfferLetterDto,
  ) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    return {
      html: await this.renderOffer(cand, ob, dto),
    };
  }

  /**
   * Send the offer letter.
   *
   * The rendered letter is stored as it went out — the candidate holds a copy,
   * so it must not change later because a template or a salary did.
   */
  async sendOffer(candidateId: string, userId: string, dto: OfferLetterDto) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    if (!cand.email) {
      throw new BadRequestException(
        'This candidate has no email address on file',
      );
    }

    await this.resolveFixedDesignation(cand, ob, dto.fixedDesignation);
    const input = await this.letterInput(cand, ob, dto);
    const letter = buildOfferLetter(dto.format, input);
    const link = this.publicLink(ob.token ?? '');

    // The letter travels as a PDF on DBL's pad; the mail body is the short
    // covering note Corporate HR sends with it. If Chromium cannot start we
    // fall back to the letter in the body rather than hold up the offer —
    // better a plain letter than none.
    // Signed by whoever sent it — "On Behalf of DBL Group, <name>, Corporate
    // HR Department", the way these go out today.
    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const email = buildOfferEmail(input, sender?.name);
    const pdf = await this.pdf.fromHtml(letter, {
      headerHtml: letterheadHeaderHtml(),
      footerHtml: letterheadFooterHtml(),
      margin: { ...LETTERHEAD_PDF_MARGIN },
      stripSelectors: [...LETTERHEAD_IN_FLOW_SELECTORS],
      // One sheet, the way these are handed over and filed. A long letter is
      // set a little smaller rather than spilling three lines onto page two.
      fitToPages: 1,
    });
    if (!pdf) {
      this.logger.warn(
        `Offer letter PDF unavailable for ${cand.id} — sending the letter inline instead.`,
      );
    }
    await this.mail.send({
      to: cand.email,
      subject: email.subject,
      text: offerEmailText(email, link),
      html: pdf
        ? offerEmailHtml(email, link)
        : `${offerEmailHtml(email, link)}<hr>${letter}`,
      attachments: pdf
        ? [
            {
              filename: `Offer Letter — ${cand.name}.pdf`,
              content: pdf,
              contentType: 'application/pdf',
            },
          ]
        : undefined,
    });

    // The letter the candidate received is filed with their documents, not just
    // emailed: a copy in the outbox of one mailbox is not a record anyone else
    // can find, and this is the document the hire rests on.
    if (pdf) {
      await this.fileWithJoiningDocs(cand.requisition, cand.name, {
        name: `Offer Letter — ${cand.name}.pdf`,
        mimeType: 'application/pdf',
        buffer: pdf,
      });
    }

    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: {
        offerSentAt: new Date(),
        status: 'offer_sent',
        // A re-send is a new offer: whatever they turned down before is no
        // longer what is on the table, so the old refusal must not linger on
        // HR's screen as though it applied to this one.
        offerDeclinedAt: null,
        offerDeclineReason: null,
        offerFormat: dto.format,
        offerRef: dto.reference?.trim() || null,
        offerJoiningDate: dto.joiningDate ? new Date(dto.joiningDate) : null,
        offerJobLocation: dto.jobLocation?.trim() || null,
        offerProbationMonths: dto.probationMonths ?? null,
        offerNoticeDays: dto.noticeDays ?? null,
        offerBenefits: dto.benefits ?? [],
        candidateAddress: dto.address?.trim() || null,
        offerLetterHtml: letter,
      },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'offer_sent',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  /**
   * The appointment letter — issued after joining, once verification is done.
   *
   * Both offer formats promise one (the junior letter calls it a Service
   * Agreement), so this closes that loop rather than being a second offer.
   */
  async previewAppointmentLetter(
    candidateId: string,
    userId: string,
    dto: AppointmentLetterDto,
  ) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    await this.resolveFixedDesignation(cand, ob, dto.fixedDesignation);
    return {
      html: buildAppointmentLetter(
        await this.letterInput(cand, ob, {
          format: 'junior',
          fixedDesignation: dto.fixedDesignation,
          reference: dto.reference,
          joiningDate: dto.joiningDate,
          address: dto.address,
        }),
      ),
    };
  }

  async sendAppointmentLetter(
    candidateId: string,
    userId: string,
    dto: AppointmentLetterDto,
  ) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    if (!cand.email) {
      throw new BadRequestException(
        'This candidate has no email address on file',
      );
    }
    if (!ob.hrVerifiedAt) {
      throw new BadRequestException(
        'Complete the final verification before issuing the appointment letter.',
      );
    }

    await this.resolveFixedDesignation(cand, ob, dto.fixedDesignation);
    const letter = buildAppointmentLetter(
      await this.letterInput(cand, ob, {
        format: 'junior',
        fixedDesignation: dto.fixedDesignation,
        reference: dto.reference,
        joiningDate: dto.joiningDate,
        address: dto.address,
      }),
    );

    // Same treatment as the offer: the letter is a document on DBL's pad, so it
    // travels as a PDF. It also has to — the pad's logo is a data: URI, which
    // Gmail and most clients refuse to load inside a message body, so an
    // inline letter would arrive with a broken image where the letterhead is.
    const appointmentPdf = await this.pdf.fromHtml(letter, {
      headerHtml: letterheadHeaderHtml(),
      footerHtml: letterheadFooterHtml(),
      margin: { ...LETTERHEAD_PDF_MARGIN },
      stripSelectors: [...LETTERHEAD_IN_FLOW_SELECTORS],
      // One sheet, the way these are handed over and filed. A long letter is
      // set a little smaller rather than spilling three lines onto page two.
      fitToPages: 1,
    });
    if (!appointmentPdf) {
      this.logger.warn(
        `Appointment letter PDF unavailable for ${cand.id} — sending the letter inline instead.`,
      );
    }
    const covering = `Dear ${cand.name},\n\nPlease find attached your appointment letter for the position of ${cand.requisition.designation} at ${cand.requisition.unitFactory}, DBL Group.\n\nWarm regards,\nDBL Group`;
    await this.mail.send({
      to: cand.email,
      subject: `Appointment letter — ${cand.requisition.designation} | DBL Group`,
      text: covering,
      html: appointmentPdf
        ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#0f172a">${covering
            .split('\n\n')
            .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
            .join('')}</div>`
        : letter,
      attachments: appointmentPdf
        ? [
            {
              filename: `Appointment Letter — ${cand.name}.pdf`,
              content: appointmentPdf,
              contentType: 'application/pdf',
            },
          ]
        : undefined,
    });

    if (appointmentPdf) {
      await this.fileWithJoiningDocs(cand.requisition, cand.name, {
        name: `Appointment Letter — ${cand.name}.pdf`,
        mimeType: 'application/pdf',
        buffer: appointmentPdf,
      });
    }

    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: {
        appointmentSentAt: new Date(),
        appointmentRef: dto.reference?.trim() || null,
        appointmentLetterHtml: letter,
        ...(dto.address?.trim()
          ? { candidateAddress: dto.address.trim() }
          : {}),
      },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'appointment_sent',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  /**
   * Everything the templates need, with stored values as the fallback.
   *
   * The signatory is whoever holds CHRO — the letters go out over their
   * signature, so it is read from the role rather than hard-coded.
   */
  /**
   * Where a candidate's address comes from, most trustworthy first.
   *
   * What HR typed wins. Then a structured CV the applicant filled in
   * themselves (Bdjobs). Then what the AI read off an uploaded CV — a
   * reading, which is why it comes last and why HR sees it in an editable
   * field before the letter goes anywhere.
   */
  private resolveAddress(
    typed: string | null | undefined,
    saved: string | null,
    cand: { cvProfile?: unknown; cvAddress?: string | null },
  ): string | null {
    if (typed?.trim()) return typed.trim();
    if (saved?.trim()) return saved.trim();
    const profile = cand.cvProfile as
      | { contact?: { currentAddress?: string; permanentAddress?: string } }
      | null
      | undefined;
    const fromProfile =
      profile?.contact?.currentAddress ?? profile?.contact?.permanentAddress;
    if (fromProfile?.trim()) return fromProfile.trim();
    return cand.cvAddress?.trim() || null;
  }

  /**
   * Settle which designation this candidate is hired at, and remember it.
   *
   * Validated against what the requisition actually offers rather than taken on
   * trust: the letter is signed and sent, and a job title typed by hand into a
   * document that becomes someone's employment contract is not something to
   * discover later. Stored so the offer letter, the appointment letter and
   * anything printed afterwards agree without the choice being made twice.
   */
  /** Preview an offer letter — same guard as sending one, nothing emailed. */
  private async renderOffer(
    cand: Parameters<OnboardingService['letterInput']>[0] & {
      requisition: { alternateDesignations?: string[] | null };
    },
    ob: Parameters<OnboardingService['letterInput']>[1] & { id: string },
    dto: OfferLetterDto,
  ): Promise<string> {
    await this.resolveFixedDesignation(cand, ob, dto.fixedDesignation);
    return buildOfferLetter(dto.format, await this.letterInput(cand, ob, dto));
  }

  private async resolveFixedDesignation(
    cand: {
      requisition: {
        designation: string;
        alternateDesignations?: string[] | null;
      };
    },
    ob: { id: string; fixedDesignation?: string | null },
    chosen?: string | null,
  ): Promise<string | null> {
    const picked = chosen?.trim();
    if (!picked) return ob.fixedDesignation?.trim() || null;

    const offered = [
      cand.requisition.designation,
      ...(cand.requisition.alternateDesignations ?? []),
    ].map((d) => d.trim());

    const match = offered.find((d) => d.toLowerCase() === picked.toLowerCase());
    if (!match) {
      throw new BadRequestException(
        `"${picked}" is not one of the designations this requisition was raised for (${offered.join(', ')}).`,
      );
    }

    // Store the requisition's own spelling, not the caller's casing.
    if (ob.fixedDesignation !== match) {
      await this.prisma.onboarding.update({
        where: { id: ob.id },
        data: { fixedDesignation: match },
      });
    }
    return match;
  }

  private async letterInput(
    cand: {
      name: string;
      cvProfile?: unknown;
      cvAddress?: string | null;
      requisition: {
        designation: string;
        alternateDesignations?: string[] | null;
        department?: string | null;
        unitFactory: string;
      };
    },
    ob: {
      offerRef: string | null;
      offerJoiningDate: Date | null;
      offerJobLocation: string | null;
      offerProbationMonths: number | null;
      offerNoticeDays: number | null;
      offerBenefits: string[];
      candidateAddress: string | null;
      fixedDesignation?: string | null;
    },
    dto: Partial<OfferLetterDto> & { format: LetterFormat },
  ): Promise<LetterInput> {
    // Already validated and stored by resolveFixedDesignation before any
    // letter is rendered; read here so every format prints the same title.
    const fixedDesignation =
      dto.fixedDesignation?.trim() || ob.fixedDesignation?.trim() || null;
    const chro = await this.prisma.roleAssignment.findFirst({
      where: { role: { key: 'chro' } },
      select: { user: { select: { name: true } } },
    });
    return {
      candidateName: cand.name,
      salutation: dto.salutation ?? null,
      address: this.resolveAddress(dto.address, ob.candidateAddress, cand),
      // The level this person is actually hired at. Falls back to the
      // requisition's primary designation, which is every candidate on a
      // single-designation requisition.
      designation: fixedDesignation ?? cand.requisition.designation,
      department: cand.requisition.department ?? null,
      unitFactory: cand.requisition.unitFactory,
      reference: dto.reference ?? ob.offerRef,
      date: new Date(),
      joiningDate: dto.joiningDate
        ? new Date(dto.joiningDate)
        : ob.offerJoiningDate,
      jobLocation: dto.jobLocation ?? ob.offerJobLocation,
      probationMonths: dto.probationMonths ?? ob.offerProbationMonths ?? 6,
      noticeDays: dto.noticeDays ?? ob.offerNoticeDays ?? 15,
      benefits: dto.benefits ?? ob.offerBenefits ?? [],
      signatoryName: chro?.user.name ?? 'Chief Human Resources Officer',
      signatoryTitle: 'Chief Human Resources Officer',
    };
  }

  /**
   * HR marks the offer accepted by hand — the candidate confirmed in person
   * or by phone rather than through the online accept-offer link. Mirrors
   * `publicAcceptOffer`'s effect (same fields, same notification fan-out) so
   * the rest of the pipeline (medical queue, etc.) can't tell the difference.
   */
  async markOfferAcceptedManually(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    const alreadyAccepted = Boolean(ob.offerAcceptedAt);
    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: alreadyAccepted
        ? {}
        : { offerAcceptedAt: new Date(), status: 'offer_accepted' },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
    });
    if (!alreadyAccepted) {
      const unit = cand.requisition.unitFactory;
      const hrIds = await this.permissions.recruitmentRecipients(
        unit,
        cand.requisition.recruiterId,
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
        message: `${cand.name} accepted the offer for ${cand.requisition.designation} (confirmed by HR).`,
        link: `/requisitions/${cand.requisitionId}`,
      });
      await this.notifications.notifyMany(medIds, {
        type: 'onboarding',
        title: 'Medical clearance needed',
        message: `${cand.name} accepted their offer — please schedule medical clearance.`,
        link: `/medical`,
      });
      this.notifications.broadcastChange('candidate', cand.requisitionId, {
        action: 'offer_accepted',
      });
    }
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  // --- HR: final verify + archive (Stage D) --------------------------------

  async hrVerify(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    // Every required document has to be in and checked — or HR has to have
    // said, in the file, that they checked them by hand. This step closes the
    // hire and rejects everyone else in the requisition, so "we'll chase that
    // certificate later" is not something it should be possible to do silently.
    const docs = await this.prisma.onboardingDoc.findMany({
      where: { onboardingId: ob.id },
      select: { label: true, status: true },
    });
    const blocker = hrVerifyBlocker(REQUIRED_DOCS, {
      docs,
      docsSkippedAt: ob.docsSkippedAt,
      verificationSkippedAt: ob.verificationSkippedAt,
      medicalStatus: ob.medicalStatus,
    });
    if (blocker) throw new BadRequestException(blocker);
    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { hrVerifiedAt: new Date(), status: 'hr_final' },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
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
          // The folder stays PRIVATE. It holds the candidate's national ID,
          // certificates and photographs; publishing it as "anyone with the
          // link" gave every one of those documents a permanent unauthenticated
          // URL. HR opens the individual documents through this API instead,
          // and this URL is retained only for the recruitment account's own use.
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
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
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
    // Guard the state machine: IT hand-off is the final step, and completes
    // onboarding — HR final verification (which itself requires medical
    // clearance) and Board Approval (a real board vote, or HR approving on
    // the board's behalf with a justifying attachment) must both be done first.
    if (!ob.hrVerifiedAt) {
      throw new BadRequestException(
        'Complete HR final verification before notifying IT',
      );
    }
    const boardApproval = await this.prisma.boardApproval.findFirst({
      where: { candidateId },
    });
    if (boardApproval?.status !== 'approved') {
      throw new BadRequestException(
        'Board Approval is required before onboarding can be completed',
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
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'it_notified',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  /**
   * Stream one submitted onboarding document.
   *
   * Two different gates, chosen by what the document is. An ordinary joining
   * document (national ID, certificate, photograph) needs recruitment access to
   * this candidate. A medical record needs a medical role — recruitment can see
   * that the report exists and whether the candidate was cleared, but not open
   * the report itself.
   */
  async streamDoc(docId: string, userId: string, res: Response): Promise<void> {
    const doc = await this.prisma.onboardingDoc.findUnique({
      where: { id: docId },
      include: {
        onboarding: {
          include: { candidate: { include: { requisition: true } } },
        },
      },
    });
    if (!doc) throw new NotFoundException('Document not found');

    if (isMedicalDoc(doc.label)) {
      await this.requireMedicalRole(userId);
    } else {
      await this.requireRecruitmentAccess(
        doc.onboarding.candidate.requisition,
        userId,
        "open this candidate's documents",
      );
    }
    await this.secureFiles.stream(res, doc.fileId, { filename: doc.label });
  }

  /**
   * Stream the Medical Fitness Report for an onboarding.
   *
   * Medical roles only, unconditionally — this is the single most sensitive
   * document the system stores, and it used to carry a permanent public Drive
   * link that anyone who was ever forwarded it could open forever.
   */
  async streamMedicalReport(
    onboardingId: string,
    userId: string,
    res: Response,
  ): Promise<void> {
    await this.requireMedicalRole(userId);
    const doc = await this.prisma.onboardingDoc.findFirst({
      where: {
        onboardingId,
        label: { contains: 'Medical', mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!doc)
      throw new NotFoundException('No medical report has been uploaded');
    await this.secureFiles.stream(res, doc.fileId, { filename: doc.label });
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
      where: { medicalStatus: 'pending', archivedAt: null, ...MEDICAL_DUE },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
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
      // Was `offerAcceptedAt` — always null now that the offer follows medical.
      orderBy: { createdAt: 'asc' },
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
      include: {
        candidate: { include: { requisition: true } },
        medicalExam: true,
      },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');

    // A by-hand result is HR's to record as well as the medical team's: the
    // exam happened on paper, often at a clinic that never touches this
    // system, and waiting for someone to retype it into the structured form
    // stalls the candidate. The structured form itself stays medical-only.
    if (dto.manual) {
      if (!(await this.hasMedicalRole(userId))) {
        await this.requireRecruitmentAccess(
          ob.candidate.requisition,
          userId,
          'record a medical result by hand',
        );
      }
    } else {
      await this.requireMedicalRole(userId);
    }

    // A by-hand result attests to an exam done on paper, so the structured
    // form is not required — but a note is, because that note plus any
    // uploaded report is then the only record of what was actually checked.
    if (dto.manual && dto.status !== 'pending' && !dto.note?.trim()) {
      throw new BadRequestException(
        'Add a note describing the manual check — it is the only record of what was examined.',
      );
    }

    if (dto.status === 'cleared' && !dto.manual) {
      const exam = ob.medicalExam;
      const missing = REQUIRED_MEDICAL_EXAM_FIELDS.filter(
        (f) => exam?.[f.key] === null || exam?.[f.key] === undefined,
      ).map((f) => f.label);
      if (missing.length) {
        throw new BadRequestException(
          `Complete the medical exam form before clearing, or record it as a manual check: ${missing.join(', ')}`,
        );
      }
    }

    // A structured finding is a SUBMISSION, not a clearance: it waits for the
    // Central Medical Officer. A by-hand result stays immediate by explicit
    // business decision — the exam happened at a clinic outside this system and
    // holding the candidate for a second review of a typed-up slip was judged
    // not worth the delay. It is recorded as manual and never carries a CMO
    // name, so the two are always distinguishable.
    const awaitsCmo = dto.status !== 'pending' && !dto.manual;

    await this.prisma.onboarding.update({
      where: { id: onboardingId },
      data: {
        medicalStatus: awaitsCmo ? 'submitted' : dto.status,
        medicalProposed: awaitsCmo ? dto.status : null,
        medicalSubmittedAt: awaitsCmo ? new Date() : null,
        medicalSubmittedById: awaitsCmo ? userId : null,
        // Any new finding clears a previous central decision — otherwise a
        // resubmission would still be wearing the last CMO's sign-off.
        medicalApprovedAt: null,
        medicalApprovedById: null,
        medicalCmoNote: null,
        medicalNote: dto.note ?? null,
        medicalClearedAt:
          !awaitsCmo && dto.status === 'cleared' ? new Date() : null,
        // A rejection recorded on paper is just as manual as a clearance, and
        // the badge should say so either way.
        medicalManual: dto.status === 'pending' ? false : Boolean(dto.manual),
        // The examining officer of record, whichever way it goes — the person
        // who made the finding, not whoever later confirms it.
        medicalClearedById: dto.status === 'pending' ? null : userId,
        status: ob.status === 'offer_accepted' ? 'medical' : ob.status,
      },
    });

    if (awaitsCmo) {
      // The queue is the CMO's; HR is told once there is an outcome, not that
      // one is pending, or every submission becomes two notifications.
      // The unit is passed because the lookup takes one; the role is GLOBAL,
      // and holderAssignments matches `unitId: null` regardless — so every CMO
      // is reached, and a unit-scoped one would still behave sensibly.
      const cmoIds = await this.permissions.roleHolderUserIds(
        CENTRAL_MEDICAL_ROLE_KEY,
        ob.candidate.requisition.unitFactory,
      );
      await this.notifications.notifyMany(cmoIds, {
        type: 'onboarding',
        title: 'Medical awaiting your approval',
        message: `${ob.candidate.name} (${ob.candidate.requisition.designation}) — examining officer recorded "${dto.status}".`,
        link: `/medical-approvals`,
      });
      this.notifications.broadcastChange(
        'candidate',
        ob.candidate.requisitionId,
        { action: 'medical_updated' },
      );
      return { ok: true, awaitingApproval: true };
    }

    // Tell Head of Talent Acquisition the candidate cleared (or didn't).
    const hrIds = await this.permissions.recruitmentRecipients(
      ob.candidate.requisition.unitFactory,
      ob.candidate.requisition.recruiterId,
    );
    await this.notifications.notifyMany(hrIds, {
      type: 'onboarding',
      title: `Medical ${dto.status}`,
      message: `${ob.candidate.name} (${ob.candidate.requisition.designation}) medical is ${dto.status}${
        dto.status !== 'pending' && dto.manual ? ' (recorded by hand)' : ''
      }.`,
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

  // ── Pre-employment medical test letter ────────────────────────────────────

  /**
   * What the send screen needs before HR can send anything.
   *
   * The age band is offered from the candidate's date of birth and left
   * changeable: the two test lists differ by an actual test, so a wrong band
   * means a test nobody runs — but Bdjobs applicants often have no date at all,
   * and blocking the send would strand them.
   */
  async medicalLetterDraft(onboardingId: string, userId: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');
    if (!(await this.hasMedicalRole(userId))) {
      await this.requireRecruitmentAccess(ob.candidate.requisition, userId);
    }

    const medical = await this.prisma.user.findMany({
      where: {
        roleAssignments: {
          some: {
            role: {
              key: { in: [...MEDICAL_ROLE_KEYS, CENTRAL_MEDICAL_ROLE_KEY] },
            },
          },
        },
      },
      select: { name: true, email: true },
      orderBy: { name: 'asc' },
    });

    const cv = ob.candidate.cvProfile as unknown as CvProfile | null;
    const dob = cv?.personal?.dateOfBirth ?? null;
    const suggested = bandFromDateOfBirth(dob);

    return {
      candidateName: ob.candidate.name,
      candidateEmail: ob.candidate.email ?? null,
      unitName: ob.candidate.requisition.unitFactory,
      dateOfBirth: dob,
      /** Null when there is no usable date — HR is then asked to choose. */
      suggestedBand: suggested,
      /** Re-sending repeats the reference rather than burning a new one. */
      refNo: ob.medicalRefNo,
      examAt: ob.medicalExamAt?.toISOString() ?? null,
      venue: ob.medicalVenue?.trim() || MEDICAL_TEST_VENUE,
      band: (ob.medicalAgeBand as MedicalAgeBand | null) ?? suggested,
      sentAt: ob.medicalLetterSentAt?.toISOString() ?? null,
      teamSentAt: ob.medicalLetterTeamSentAt?.toISOString() ?? null,
      candidateSentAt: ob.medicalLetterCandidateSentAt?.toISOString() ?? null,
      /**
       * Who the letter will reach, resolved from the medical roles.
       *
       * Shown before sending rather than discovered afterwards: an empty list
       * means nobody holds the role, and the send screen should say so while
       * it can still be fixed.
       */
      recipients: medical.map((u) => ({
        name: u.name,
        email: u.email,
        hasEmail: Boolean(u.email),
      })),
    };
  }

  /**
   * Send the medical test letter.
   *
   * Two different emails go out. The clinic gets the letter — reference, tests,
   * appointment. The candidate gets where to be, when, and what to bring; the
   * test list is deliberately not repeated to them.
   *
   * Sent by business decision as email bodies rather than attachments: the
   * clinic reads an instruction and a checklist, and an email they can forward
   * is enough.
   */
  async sendMedicalTestLetter(
    onboardingId: string,
    userId: string,
    dto: SendMedicalLetterDto,
  ) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');
    if (!(await this.hasMedicalRole(userId))) {
      await this.requireRecruitmentAccess(
        ob.candidate.requisition,
        userId,
        'send the medical test letter',
      );
    }
    if (!this.mail.isConfigured()) {
      throw new ServiceUnavailableException('Email is not configured');
    }

    // Chosen value, else what this candidate's last letter used, else the
    // default — so a corrected address survives a re-send.
    const venue =
      dto.venue?.trim() || ob.medicalVenue?.trim() || MEDICAL_TEST_VENUE;

    const examAt = new Date(dto.examAt);
    if (Number.isNaN(examAt.getTime())) {
      throw new BadRequestException('Give a valid appointment date and time');
    }

    // The reference is issued once and kept. A re-send — a candidate who lost
    // the email, a corrected time — must not produce a second number for the
    // same person, because the clinic files by it.
    let refNo = ob.medicalRefNo;
    if (!refNo) {
      const [{ nextval }] = await this.prisma.$queryRaw<{ nextval: bigint }[]>`
        SELECT nextval('medical_test_ref_seq')
      `;
      const yy = String(examAt.getFullYear()).slice(-2);
      refNo = `DBL/Corp/HR/MT - ${nextval}/${yy}`;
    }

    const letter = buildMedicalTestLetter({
      candidateName: ob.candidate.name,
      salutation: dto.salutation ?? null,
      unitName: ob.candidate.requisition.unitFactory,
      refNo,
      band: dto.band,
      examAt,
      venue,
    });

    // Recipients come from the roles, not from a typed list: these people are
    // already in the system with their addresses on their accounts, and
    // retyping them per send is a transcription error headed for an external
    // clinic.
    const medicalUsers = await this.prisma.user.findMany({
      where: {
        roleAssignments: {
          some: {
            role: {
              key: { in: [...MEDICAL_ROLE_KEYS, CENTRAL_MEDICAL_ROLE_KEY] },
            },
          },
        },
      },
      select: { id: true, name: true, email: true },
    });

    if (!medicalUsers.length) {
      throw new BadRequestException(
        'Nobody holds the Medical Officer or Central Medical Officer role, so there is nowhere to send this letter. Assign one in Access Control first.',
      );
    }

    const recipients = medicalUsers.filter((u) => u.email);
    const noEmail = medicalUsers.filter((u) => !u.email).map((u) => u.name);
    if (!recipients.length) {
      throw new BadRequestException(
        `No medical role holder has an email address on file (${noEmail.join(', ')}). Add one before sending.`,
      );
    }

    const toTeam = dto.notifyMedicalTeam !== false;
    const toCandidate =
      dto.notifyCandidate !== false && Boolean(ob.candidate.email);
    if (!toTeam && !toCandidate) {
      throw new BadRequestException(
        'Choose at least one recipient — an email to nobody is not a send.',
      );
    }

    const sent: string[] = [];
    const failed: { to: string; reason: string }[] = [];
    let teamSentAt: Date | null = null;
    let candidateSentAt: Date | null = null;

    // The medical team first: if this fails there is no appointment to keep,
    // and telling the candidate to attend would be worse than telling nobody.
    for (const to of toTeam ? recipients.map((u) => u.email as string) : []) {
      try {
        await this.mail.send({
          to,
          subject: `Medical Tests — ${ob.candidate.name} | ${refNo}`,
          text: `Medical test letter for ${ob.candidate.name}. Reference ${refNo}.`,
          html: letter,
        });
        sent.push(to);
        teamSentAt = new Date();
      } catch (err) {
        failed.push({ to, reason: (err as Error).message });
      }
    }

    if (toCandidate && ob.candidate.email) {
      const mail = buildCandidateMedicalEmail({ examAt, venue });
      try {
        await this.mail.send({
          to: ob.candidate.email,
          subject: 'Pre-employment Medical Test | DBL Group',
          text: mail.text,
          html: mail.html,
        });
        sent.push(ob.candidate.email);
        candidateSentAt = new Date();
      } catch (err) {
        failed.push({
          to: ob.candidate.email,
          reason: (err as Error).message,
        });
      }
    }

    // Recorded even on a partial failure: the reference was issued and the
    // appointment agreed, and losing that because one address bounced would
    // mean re-issuing a number the clinic may already hold.
    await this.prisma.onboarding.update({
      where: { id: onboardingId },
      data: {
        medicalRefNo: refNo,
        medicalExamAt: examAt,
        medicalVenue: venue,
        medicalAgeBand: dto.band,
        medicalLetterSentAt: sent.length ? new Date() : ob.medicalLetterSentAt,
        // Kept from the previous send when this one did not target that side:
        // re-sending only to the candidate must not erase the record that the
        // clinic was told last week.
        medicalLetterTeamSentAt: teamSentAt ?? ob.medicalLetterTeamSentAt,
        medicalLetterCandidateSentAt:
          candidateSentAt ?? ob.medicalLetterCandidateSentAt,
      },
    });

    this.notifications.broadcastChange(
      'candidate',
      ob.candidate.requisitionId,
      {
        action: 'medical_updated',
      },
    );

    return {
      refNo,
      sent,
      failed,
      /** Role holders with no address — named so somebody fixes the account. */
      skippedNoEmail: noEmail,
      teamSentAt: teamSentAt?.toISOString() ?? null,
      candidateSentAt: candidateSentAt?.toISOString() ?? null,
      letterHtml: letter,
    };
  }

  // ── Central Medical Officer ───────────────────────────────────────────────

  /** Only a Central Medical Officer (or a super user) may decide a submission. */
  private async requireCentralMedicalOfficer(userId: string): Promise<void> {
    if (await this.permissions.isSuperUser(userId)) return;
    const holds = await this.prisma.roleAssignment.findFirst({
      where: { userId, role: { key: CENTRAL_MEDICAL_ROLE_KEY } },
      select: { id: true },
    });
    if (!holds) {
      throw new ForbiddenException(
        'Only the Central Medical Officer can approve medical findings',
      );
    }
  }

  /**
   * Everything waiting on the Central Medical Officer.
   *
   * Oldest first: a queue worked newest-first leaves the people who have waited
   * longest waiting longer, and these are candidates whose start date is
   * already booked.
   */
  async medicalApprovalQueue(userId: string) {
    await this.requireCentralMedicalOfficer(userId);
    const rows = await this.prisma.onboarding.findMany({
      where: { medicalStatus: 'submitted', archivedAt: null },
      orderBy: { medicalSubmittedAt: 'asc' },
      include: {
        medicalExam: true,
        medicalSubmittedBy: { select: { id: true, name: true } },
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
    });

    return rows.map((ob) => ({
      onboardingId: ob.id,
      candidateId: ob.candidateId,
      candidateName: ob.candidate.name,
      requisition: ob.candidate.requisition,
      /** What the examining officer put forward — what is being confirmed. */
      proposed: ob.medicalProposed,
      note: ob.medicalNote ?? null,
      submittedAt: ob.medicalSubmittedAt?.toISOString() ?? null,
      submittedBy: ob.medicalSubmittedBy?.name ?? null,
      /** The clinical findings. The CMO is medical; they read the full record. */
      exam: this.serializeFullMedicalExam(ob.medicalExam),
    }));
  }

  /**
   * Decide one submission.
   *
   * Returns the outcome rather than throwing on a record someone else has
   * already handled — see decideMedicalMany, which is the same call in a loop.
   */
  async decideMedical(
    onboardingId: string,
    userId: string,
    dto: { decision: CmoDecision; note?: string },
  ) {
    await this.requireCentralMedicalOfficer(userId);
    const result = await this.decideOne(onboardingId, userId, dto);
    if (result.error) throw new BadRequestException(result.error);
    return { ok: true, status: result.status };
  }

  /**
   * Decide many at once.
   *
   * Each record is judged on its own: one candidate handled by another CMO a
   * moment earlier must not fail the other forty. The reply says exactly what
   * happened to each, so the panel can show which rows did not go through
   * instead of claiming a clean sweep.
   */
  async decideMedicalMany(
    userId: string,
    dto: { onboardingIds: string[]; decision: CmoDecision; note?: string },
  ) {
    await this.requireCentralMedicalOfficer(userId);

    const noteProblem = decisionNoteError(dto.decision, dto.note);
    if (noteProblem) throw new BadRequestException(noteProblem);

    const results: {
      onboardingId: string;
      ok: boolean;
      status?: string;
      error?: string;
    }[] = [];
    // Sequential on purpose: each decision writes a row, sends notifications
    // and is independently auditable. Forty at once is a person clicking a
    // button, not a throughput problem worth a transaction for.
    for (const id of dto.onboardingIds) {
      const r = await this.decideOne(id, userId, dto);
      results.push({
        onboardingId: id,
        ok: !r.error,
        status: r.status,
        error: r.error,
      });
    }
    return {
      decided: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /** One decision, applied. Never throws for a record-level problem. */
  private async decideOne(
    onboardingId: string,
    userId: string,
    dto: { decision: CmoDecision; note?: string },
  ): Promise<{ status?: string; error?: string }> {
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) return { error: 'Onboarding not found' };

    const blocker = submissionBlocker({
      medicalStatus: ob.medicalStatus,
      medicalProposed: ob.medicalProposed,
    });
    if (blocker) return { error: blocker };

    const noteProblem = decisionNoteError(dto.decision, dto.note);
    if (noteProblem) return { error: noteProblem };

    const next = applyCmoDecision(
      dto.decision,
      ob.medicalProposed as ProposedMedical,
    );
    const note = dto.note?.trim() || null;

    await this.prisma.onboarding.update({
      where: { id: onboardingId },
      data: {
        medicalStatus: next.status,
        medicalCmoNote: note,
        // Returned to the officer: the finding is withdrawn, so the proposal
        // and the submission stamp go with it. Anything else would leave the
        // record looking like it is still in the queue.
        medicalProposed: next.decided ? ob.medicalProposed : null,
        medicalSubmittedAt: next.decided ? ob.medicalSubmittedAt : null,
        medicalSubmittedById: next.decided ? ob.medicalSubmittedById : null,
        medicalApprovedAt: next.decided ? new Date() : null,
        medicalApprovedById: next.decided ? userId : null,
        medicalClearedAt: next.status === 'cleared' ? new Date() : null,
        medicalClearedById: next.decided ? ob.medicalClearedById : null,
      },
    });

    // The examining officer hears every outcome — including agreement, because
    // silence on approval makes a return or an overturn feel like a reprimand.
    if (ob.medicalSubmittedById) {
      await this.notifications.notifyMany([ob.medicalSubmittedById], {
        type: 'onboarding',
        title: `Medical ${next.decided ? next.status : 'returned'}`,
        message: `${ob.candidate.name}: ${next.summary}${note ? ` — ${note}` : ''}`,
        link: `/requisitions/${ob.candidate.requisitionId}`,
      });
    }

    // Recruitment is told only once there is an outcome to act on.
    if (next.decided) {
      const hrIds = await this.permissions.recruitmentRecipients(
        ob.candidate.requisition.unitFactory,
        ob.candidate.requisition.recruiterId,
      );
      await this.notifications.notifyMany(hrIds, {
        type: 'onboarding',
        title: `Medical ${next.status}`,
        message: `${ob.candidate.name} (${ob.candidate.requisition.designation}) — ${next.summary}`,
        link: `/requisitions/${ob.candidate.requisitionId}`,
      });
    }

    this.notifications.broadcastChange(
      'candidate',
      ob.candidate.requisitionId,
      {
        action: 'medical_updated',
      },
    );
    return { status: next.status };
  }

  /** Medical exam form data is readable by the medical team (who fill it in)
   * and by Head of Talent Acquisition / CHRO (who view the summary on the onboarding page). */
  async getMedicalExam(onboardingId: string, userId: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');

    const isMedical = await this.canReadFullMedical(userId);
    if (!isMedical) {
      // Recruitment may confirm the check happened and whether the candidate
      // is fit. It may not read the clinical findings — this method used to
      // return the whole record to anyone with recruitment access.
      await this.requireRecruitmentAccess(ob.candidate.requisition, userId);
    }

    const exam = await this.prisma.medicalExam.findUnique({
      where: { onboardingId },
    });
    return isMedical
      ? this.serializeFullMedicalExam(exam)
      : this.serializeMedicalSummary(exam);
  }

  async upsertMedicalExam(
    onboardingId: string,
    dto: MedicalExamDto,
    userId: string,
  ) {
    await this.requireMedicalRole(userId);
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');

    // Ref No is assigned once, automatically, on first save — not typed in
    // by the officer (format: DBL/Corp/HR/MT-<seq>/<yy>, seq resets yearly).
    const existing = await this.prisma.medicalExam.findUnique({
      where: { onboardingId },
      select: { refNo: true },
    });
    const refNo = existing?.refNo ?? (await this.generateMedicalRefNo());

    // undefined = field not sent, leave alone; null = explicitly cleared;
    // string = set. Collapsing null into undefined here would make clearing
    // a date field a no-op that silently keeps the old value.
    const toDate = (v: string | null | undefined) =>
      v === undefined ? undefined : v === null ? null : new Date(v);

    const values = {
      dateOfBirth: toDate(dto.dateOfBirth),
      dutyPosition: dto.dutyPosition,
      refNo,
      registrationNo: dto.registrationNo,
      examDate: toDate(dto.examDate),
      issueDate: toDate(dto.issueDate),
      consultantName: dto.consultantName,
      height: dto.height,
      weight: dto.weight,
      pulse: dto.pulse,
      bloodPressure: dto.bloodPressure,
      visionRightEye: dto.visionRightEye,
      visionLeftEye: dto.visionLeftEye,
      visionWithGlass: dto.visionWithGlass,
      colorVisionYellow: dto.colorVisionYellow,
      colorVisionRed: dto.colorVisionRed,
      colorVisionGreen: dto.colorVisionGreen,
      colorVisionBlue: dto.colorVisionBlue,
      hearingRightEar: dto.hearingRightEar,
      hearingLeftEar: dto.hearingLeftEar,
      speech: dto.speech,
      extremities: dto.extremities,
      noAnemiaJaundiceEtc: dto.noAnemiaJaundiceEtc,
      stableNormotensiveNondiabetic: dto.stableNormotensiveNondiabetic,
      urineTestClear: dto.urineTestClear,
      hepatitisBNegative: dto.hepatitisBNegative,
      liverFunctionNormal: dto.liverFunctionNormal,
      pastIllnessHistory: dto.pastIllnessHistory,
      familyHistoryDmHtn: dto.familyHistoryDmHtn,
      familyHistoryDetail: dto.familyHistoryDetail,
      bloodGroup: dto.bloodGroup,
      fitToJoin: dto.fitToJoin,
      remarks: dto.remarks,
    };

    const exam = await this.prisma.medicalExam.upsert({
      where: { onboardingId },
      create: { onboardingId, ...values },
      update: values,
    });
    return this.serializeFullMedicalExam(exam);
  }

  /** Medical officer attaches the actual signed report (optional — the
   * structured fields above are the source of truth for clearance). */
  async uploadMedicalReport(
    onboardingId: string,
    file: UploadedDoc | undefined,
    userId: string,
  ) {
    if (!file) throw new BadRequestException('Please attach a file');
    await this.requireMedicalRole(userId);
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');

    const ws = await this.recruitment.ensureWorkspace(ob.candidate.requisition);
    if (!ws) {
      throw new ServiceUnavailableException(
        'Upload is temporarily unavailable. Please try again later.',
      );
    }
    const folder = await this.drive.ensureFolder(
      `${ob.candidate.name} — Joining Docs`,
      ws.joiningFolderId,
    );
    const uploaded = await this.drive.uploadFile(folder, {
      name: `Medical Fitness Report — ${file.originalname}`,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    // The Medical Fitness Report is the most sensitive document this system
    // holds. It stays private to the recruitment Google account and is streamed
    // only to medical-role holders — see streamMedicalReport() below.
    const createdDoc = await this.prisma.onboardingDoc.create({
      data: {
        onboardingId: ob.id,
        label: 'Medical Fitness Report',
        fileId: uploaded.id,
        url: uploaded.url,
        mimeType: file.mimetype,
      },
    });
    this.notifications.broadcastChange(
      'candidate',
      ob.candidate.requisitionId,
      { action: 'medical_updated' },
    );
    return {
      id: createdDoc.id,
      label: createdDoc.label,
      url:
        this.files.url(createdDoc.fileId, 'medical-report', {
          filename: createdDoc.label,
        }) ?? createdDoc.url,
      mimeType: createdDoc.mimeType,
      createdAt: createdDoc.createdAt.toISOString(),
    };
  }

  // --- Public (candidate, by token) ----------------------------------------

  async publicGet(token: string) {
    const ob = await this.prisma.onboarding.findFirst({
      where: tokenLookupWhere(token),
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
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
      optionalDocs: OPTIONAL_DOCS,
      offerSentAt: ob.offerSentAt?.toISOString() ?? null,
      offerAcceptedAt: ob.offerAcceptedAt?.toISOString() ?? null,
      offerDeclinedAt: ob.offerDeclinedAt?.toISOString() ?? null,
      offerDeclineReason: ob.offerDeclineReason,
      cocSentAt: ob.cocSentAt?.toISOString() ?? null,
      cocSignedAt: ob.cocSignedAt?.toISOString() ?? null,
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
    const ob = await this.prisma.onboarding.findFirst({
      where: tokenLookupWhere(token),
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
    // Nudge Head of Talent Acquisition that a document came in.
    const hrIds = await this.permissions.recruitmentRecipients(
      ob.candidate.requisition.unitFactory,
      ob.candidate.requisition.recruiterId,
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
    const ob = await this.prisma.onboarding.findFirst({
      where: tokenLookupWhere(token),
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('This link is not valid');
    if (!ob.offerSentAt)
      throw new BadRequestException('No offer has been sent yet');
    if (ob.offerDeclinedAt) {
      throw new BadRequestException(
        'You have already declined this offer. Please contact DBL Group HR if you would like to reconsider.',
      );
    }
    if (!ob.offerAcceptedAt) {
      await this.prisma.onboarding.update({
        where: { id: ob.id },
        data: { offerAcceptedAt: new Date(), status: 'offer_accepted' },
      });
      // Offer accepted → notify Head of Talent Acquisition + medical officers (triggers medical).
      const unit = ob.candidate.requisition.unitFactory;
      const hrIds = await this.permissions.recruitmentRecipients(
        unit,
        ob.candidate.requisition.recruiterId,
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

  /**
   * The candidate turns the offer down.
   *
   * The reason is required. A bare "no" tells HR nothing they can act on —
   * whether to improve the offer, ask what went wrong, or go to the next
   * candidate — and this note is the only record of it. It is shown back to
   * HR on the offer section of the onboarding page.
   */
  async publicDeclineOffer(token: string, reason: string) {
    const text = reason?.trim() ?? '';
    if (text.length < 3) {
      throw new BadRequestException(
        'Please tell us why you are declining — it is the only thing HR will have to go on.',
      );
    }

    const ob = await this.prisma.onboarding.findFirst({
      where: tokenLookupWhere(token),
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('This link is not valid');
    if (!ob.offerSentAt)
      throw new BadRequestException('No offer has been sent yet');
    if (ob.offerAcceptedAt) {
      throw new BadRequestException(
        'You have already accepted this offer. Please contact DBL Group HR directly.',
      );
    }
    if (ob.offerDeclinedAt) return { ok: true, alreadyDeclined: true };

    await this.prisma.onboarding.update({
      where: { id: ob.id },
      // Status deliberately stays `offer_sent`: the offer was made, and HR may
      // yet send a revised one. The timestamp is what says it was refused.
      data: { offerDeclinedAt: new Date(), offerDeclineReason: text },
    });

    const hrIds = await this.permissions.recruitmentRecipients(
      ob.candidate.requisition.unitFactory,
      ob.candidate.requisition.recruiterId,
    );
    await this.notifications.notifyMany(hrIds, {
      type: 'onboarding',
      title: 'Offer declined',
      message: `${ob.candidate.name} declined the offer for ${ob.candidate.requisition.designation} — ${text}`,
      link: `/requisitions/${ob.candidate.requisitionId}`,
    });
    this.notifications.broadcastChange(
      'candidate',
      ob.candidate.requisitionId,
      { action: 'offer_declined' },
    );

    return { ok: true, alreadyDeclined: false };
  }

  // --- Code of Conduct -----------------------------------------------------

  /**
   * Send the candidate DBL's Code of Conduct acknowledgement to sign.
   *
   * The blank form goes as a PDF so they can read it away from the screen, and
   * the mail points at their own portal, where they sign it. Nothing is filed
   * until they do.
   */
  async sendCoc(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const ob = await this.requireOnboarding(candidateId);
    if (!cand.email) {
      throw new BadRequestException(
        'This candidate has no email address on file',
      );
    }
    if (ob.cocSignedAt) {
      throw new BadRequestException(
        'This candidate has already signed the Code of Conduct.',
      );
    }

    const form = buildCocForm({ employeeName: cand.name });
    const pdf = await this.pdf.fromHtml(form, {
      margin: { top: '16mm', bottom: '14mm', left: '18mm', right: '18mm' },
      fitToPages: 1,
    });
    const link = `${this.publicLink(ob.token ?? '')}?action=coc`;

    await this.mail.send({
      to: cand.email,
      subject: 'Company Code of Conduct — your acknowledgement | DBL Group',
      text: `Dear ${cand.name},\n\nPlease read DBL Group's Code of Conduct and confirm your acknowledgement of it. The form is attached.\n\nSign it here: ${link}\n\nYou will be asked to upload a picture of your signature.\n\nWarm regards,\nCorporate HR Department\nDBL Group`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#202124;max-width:720px">
  <p>Dear ${cand.name},</p>
  <p>Please read DBL Group&rsquo;s Code of Conduct and confirm your acknowledgement of it. The form is attached for your records.</p>
  <p><a href="${link}" style="color:#1155cc">Open the form and sign it here</a>. You will be asked to upload a picture of your signature.</p>
  <p style="color:#1155cc;margin-top:20px">Corporate HR Department<br>DBL Group</p>
</div>`,
      attachments: pdf
        ? [
            {
              filename: 'DBL Group — Code of Conduct.pdf',
              content: pdf,
              contentType: 'application/pdf',
            },
          ]
        : undefined,
    });

    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { cocSentAt: new Date() },
      include: {
        docs: { orderBy: { createdAt: 'asc' } },
        medicalClearedBy: { select: { name: true } },
      },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'coc_sent',
    });
    return { onboarding: this.serialize(updated, cand.name, cand.email) };
  }

  /**
   * The candidate signs it, from their own portal.
   *
   * Their signature arrives as an image they cropped themselves, so it is
   * checked for shape before it is drawn into a document that goes in their
   * personnel file — a square or a full-page scan would letterbox into a
   * smear. The completed form is filed with their joining documents, which is
   * where anyone will look for it afterwards.
   */
  async publicSignCoc(token: string, file?: UploadedDoc) {
    if (!file) throw new BadRequestException('Please attach your signature');
    const ob = await this.prisma.onboarding.findFirst({
      where: tokenLookupWhere(token),
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('This link is not valid');
    if (!ob.cocSentAt) {
      throw new BadRequestException(
        'The Code of Conduct has not been sent to you yet.',
      );
    }
    if (ob.cocSignedAt) return { ok: true, alreadySigned: true };

    const size = imageSize(file.buffer);
    if (!size) {
      throw new BadRequestException(
        'That file is not a readable PNG or JPEG image.',
      );
    }
    const ratioError = signatureRatioError(size.width, size.height);
    if (ratioError) throw new BadRequestException(ratioError);

    const signedAt = new Date();
    const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    const form = buildCocForm({
      employeeName: ob.candidate.name,
      signatureDataUri: dataUri,
      signedAt,
    });
    const pdf = await this.pdf.fromHtml(form, {
      margin: { top: '16mm', bottom: '14mm', left: '18mm', right: '18mm' },
      fitToPages: 1,
    });
    if (!pdf) {
      throw new ServiceUnavailableException(
        'We could not produce your signed form just now. Please try again in a moment.',
      );
    }

    const filed = await this.fileWithJoiningDocs(
      ob.candidate.requisition,
      ob.candidate.name,
      {
        name: `Code of Conduct — ${ob.candidate.name}.pdf`,
        mimeType: 'application/pdf',
        buffer: pdf,
      },
    );

    await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: {
        cocSignedAt: signedAt,
        cocFileId: filed?.id ?? null,
        cocUrl: filed?.url ?? null,
      },
    });
    if (filed) {
      // Filed as a document in its own right: it belongs in the candidate's
      // paperwork, not only in a column. Verified on arrival — the candidate
      // signed it, there is nothing for HR to check it against.
      await this.prisma.onboardingDoc.create({
        data: {
          onboardingId: ob.id,
          label: COC_DOC_LABEL,
          fileId: filed.id,
          url: filed.url,
          mimeType: 'application/pdf',
          status: 'verified',
        },
      });
    }

    const hrIds = await this.permissions.recruitmentRecipients(
      ob.candidate.requisition.unitFactory,
      ob.candidate.requisition.recruiterId,
    );
    await this.notifications.notifyMany(hrIds, {
      type: 'onboarding',
      title: 'Code of Conduct signed',
      message: `${ob.candidate.name} acknowledged and signed the Code of Conduct.`,
      link: `/onboarding/manage/${ob.candidateId}`,
    });
    this.notifications.broadcastChange(
      'candidate',
      ob.candidate.requisitionId,
      { action: 'coc_signed' },
    );
    return { ok: true, alreadySigned: false };
  }

  // --- helpers -------------------------------------------------------------

  /**
   * Put a file in the candidate's own joining-documents folder.
   *
   * Everything that belongs to one candidate lands in one folder — the papers
   * they upload, their medical report, their signed Code of Conduct, the
   * letters we send them — so that at archive time the whole file moves as a
   * unit. Returns null when Drive is unavailable rather than throwing: losing
   * the filing copy must not lose the thing itself.
   */
  private async fileWithJoiningDocs(
    requisition: Parameters<RecruitmentService['ensureWorkspace']>[0],
    candidateName: string,
    upload: { name: string; mimeType: string; buffer: Buffer },
  ): Promise<{ id: string; url: string } | null> {
    try {
      const ws = await this.recruitment.ensureWorkspace(requisition);
      if (!ws) return null;
      const folder = await this.drive.ensureFolder(
        `${candidateName} — Joining Docs`,
        ws.joiningFolderId,
      );
      const uploaded = await this.drive.uploadFile(folder, upload);
      return { id: uploaded.id, url: uploaded.url };
    } catch (e) {
      this.logger.warn(
        `Could not file "${upload.name}" on Drive: ${(e as Error).message}`,
      );
      return null;
    }
  }

  private publicLink(token: string): string {
    const origin =
      this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';
    return `${origin}/onboarding/${token}`;
  }

  private async requireCandidate(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true, salaryFixation: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);
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
   * been extracted; alerts Head of Talent Acquisition if real discrepancies are found.
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

  /**
   * Post-approval work is Head of Talent Acquisition / CHRO / super — plus the Corporate
   * Recruiter assigned to this requisition. Takes the requisition (not just
   * its unit) so the assigned recruiter is always considered.
   */
  private async requireRecruitmentAccess(
    req: { unitFactory: string; recruiterId: string | null },
    userId: string,
    action = 'manage onboarding',
  ) {
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      action,
    );
  }

  /**
   * Tell the medical team a candidate is now waiting on them.
   *
   * Nothing used to reach them at all — the queue was the only signal, and it
   * was empty. Stamped so verifying five documents one at a time raises one
   * alert rather than five.
   */
  private async notifyMedicalTeamIfDue(onboardingId: string): Promise<void> {
    const ob = await this.prisma.onboarding.findFirst({
      where: {
        id: onboardingId,
        medicalStatus: 'pending',
        medicalNotifiedAt: null,
        archivedAt: null,
        ...MEDICAL_DUE,
      },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) return;

    const assignments = await this.prisma.roleAssignment.findMany({
      where: { role: { key: { in: MEDICAL_ROLE_KEYS } } },
      select: { userId: true },
    });
    const ids = [...new Set(assignments.map((a) => a.userId))];
    // Stamp regardless: with no medical officer appointed there is nobody to
    // tell, and re-checking on every document verified would achieve nothing.
    await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { medicalNotifiedAt: new Date() },
    });
    if (!ids.length) return;

    await this.notifications.notifyMany(ids, {
      type: 'onboarding',
      title: 'Medical clearance needed',
      message: `${ob.candidate.name} (${ob.candidate.requisition.designation}, ${ob.candidate.requisition.unitFactory}) is waiting for medical clearance.`,
      link: '/medical',
    });
  }

  /**
   * Send (or re-send) the medical team's alert for one candidate.
   *
   * The automatic alert fires when the documents settle. This exists because
   * that is a moment in time: a candidate whose documents settled before the
   * alert existed, or whose medical officer was appointed afterwards, would
   * otherwise wait forever with nobody told.
   */
  async alertMedicalTeam(onboardingId: string, userId: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');
    await this.requireRecruitmentAccess(
      ob.candidate.requisition,
      userId,
      'alert the medical team',
    );
    if (ob.medicalStatus !== 'pending') {
      throw new BadRequestException(
        "This candidate's medical result is already recorded.",
      );
    }

    const assignments = await this.prisma.roleAssignment.findMany({
      where: { role: { key: { in: MEDICAL_ROLE_KEYS } } },
      select: { userId: true },
    });
    const ids = [...new Set(assignments.map((a) => a.userId))];
    if (!ids.length) {
      throw new BadRequestException(
        'No medical officer is appointed yet — assign the Medical Officer role in Access Control first.',
      );
    }

    await this.notifications.notifyMany(ids, {
      type: 'onboarding',
      title: 'Medical clearance needed',
      message: `${ob.candidate.name} (${ob.candidate.requisition.designation}, ${ob.candidate.requisition.unitFactory}) is waiting for medical clearance.`,
      link: '/medical',
    });
    await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: { medicalNotifiedAt: new Date() },
    });
    return { ok: true, notified: ids.length };
  }

  /** Is the user a medical officer / team member anywhere (or a super user)? */
  private async hasMedicalRole(userId: string): Promise<boolean> {
    return (
      (await this.permissions.isSuperUser(userId)) ||
      Boolean(
        await this.prisma.roleAssignment.findFirst({
          where: { userId, role: { key: { in: MEDICAL_ROLE_KEYS } } },
        }),
      )
    );
  }

  private async requireMedicalRole(userId: string) {
    const ok = await this.hasMedicalRole(userId);
    if (!ok) {
      throw new ForbiddenException(
        'Only a medical officer / team member or super user can access medical clearance',
      );
    }
  }

  /** Next "DBL/Corp/HR/MT-<seq>/<yy>" ref no — sequence resets each year. */
  private async generateMedicalRefNo(): Promise<string> {
    const yy = String(new Date().getFullYear()).slice(-2);
    const prefix = 'DBL/Corp/HR/MT-';
    const suffix = `/${yy}`;
    const existing = await this.prisma.medicalExam.findMany({
      where: { refNo: { startsWith: prefix, endsWith: suffix } },
      select: { refNo: true },
    });
    let max = 0;
    for (const e of existing) {
      const m = e.refNo?.match(/-(\d+)\/\d{2}$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}${suffix}`;
  }

  /**
   * What a non-medical reader is told about a medical examination.
   *
   * Recruitment needs one fact to move a hire along — is this person fit to
   * join — plus enough provenance to show the check really happened. It does
   * not need hepatitis B status, liver function, urine results, past illness
   * or family history of diabetes, and those are exactly the fields this
   * projection leaves out.
   *
   * POLICY: the split between "summary" and "full" is a business decision that
   * was confirmed by the production-readiness audit (finding P-1). Changing who
   * is on which side of it is a policy change, not a code change — see
   * `canReadFullMedical()`.
   */
  private serializeMedicalSummary(exam: MedicalExam | null) {
    const toDateStr = (d: Date | null | undefined) =>
      d ? d.toISOString().slice(0, 10) : null;
    return {
      /** The only clinical conclusion a recruiter needs. */
      fitToJoin: exam?.fitToJoin ?? null,
      examDate: toDateStr(exam?.examDate),
      issueDate: toDateStr(exam?.issueDate),
      refNo: exam?.refNo ?? '',
      consultantName: exam?.consultantName ?? '',
      /** Tells the UI the full record exists without disclosing any of it. */
      recorded: Boolean(exam),
      /** Marks the payload so a client cannot mistake it for the full record. */
      redacted: true as const,
    };
  }

  /** May this user see clinical findings, as opposed to fit / not fit? */
  private async canReadFullMedical(userId: string): Promise<boolean> {
    return this.hasMedicalRole(userId);
  }

  private serializeFullMedicalExam(exam: MedicalExam | null) {
    const toDateStr = (d: Date | null | undefined) =>
      d ? d.toISOString().slice(0, 10) : null;
    return {
      dateOfBirth: toDateStr(exam?.dateOfBirth),
      dutyPosition: exam?.dutyPosition ?? '',
      refNo: exam?.refNo ?? '',
      registrationNo: exam?.registrationNo ?? '',
      examDate: toDateStr(exam?.examDate),
      issueDate: toDateStr(exam?.issueDate),
      consultantName: exam?.consultantName ?? '',
      height: exam?.height ?? '',
      weight: exam?.weight ?? '',
      pulse: exam?.pulse ?? '',
      bloodPressure: exam?.bloodPressure ?? '',
      visionRightEye: exam?.visionRightEye ?? '',
      visionLeftEye: exam?.visionLeftEye ?? '',
      visionWithGlass: exam?.visionWithGlass ?? null,
      colorVisionYellow: exam?.colorVisionYellow ?? '',
      colorVisionRed: exam?.colorVisionRed ?? '',
      colorVisionGreen: exam?.colorVisionGreen ?? '',
      colorVisionBlue: exam?.colorVisionBlue ?? '',
      hearingRightEar: exam?.hearingRightEar ?? '',
      hearingLeftEar: exam?.hearingLeftEar ?? '',
      speech: exam?.speech ?? '',
      extremities: exam?.extremities ?? '',
      noAnemiaJaundiceEtc: exam?.noAnemiaJaundiceEtc ?? null,
      stableNormotensiveNondiabetic:
        exam?.stableNormotensiveNondiabetic ?? null,
      urineTestClear: exam?.urineTestClear ?? null,
      hepatitisBNegative: exam?.hepatitisBNegative ?? null,
      liverFunctionNormal: exam?.liverFunctionNormal ?? null,
      pastIllnessHistory: exam?.pastIllnessHistory ?? '',
      familyHistoryDmHtn: exam?.familyHistoryDmHtn ?? null,
      familyHistoryDetail: exam?.familyHistoryDetail ?? '',
      bloodGroup: exam?.bloodGroup ?? '',
      fitToJoin: exam?.fitToJoin ?? null,
      remarks: exam?.remarks ?? '',
    };
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
      token: ob.token ?? '',
      submissionLink: this.publicLink(ob.token ?? ''),
      status: ob.status,
      docsSkippedAt: ob.docsSkippedAt?.toISOString() ?? null,
      verificationSkippedAt: ob.verificationSkippedAt?.toISOString() ?? null,
      offerSentAt: ob.offerSentAt?.toISOString() ?? null,
      offerAcceptedAt: ob.offerAcceptedAt?.toISOString() ?? null,
      offerDeclinedAt: ob.offerDeclinedAt?.toISOString() ?? null,
      offerDeclineReason: ob.offerDeclineReason,
      // What final verification is still waiting on, worked out in one place so
      // the modal cannot disagree with the endpoint that refuses.
      missingDocs: missingDocs(REQUIRED_DOCS, ob),
      pendingDocs: pendingDocs(ob),
      cocSentAt: ob.cocSentAt?.toISOString() ?? null,
      cocSignedAt: ob.cocSignedAt?.toISOString() ?? null,
      cocUrl: ob.cocUrl,
      medicalStatus: ob.medicalStatus,
      medicalNote: ob.medicalNote ?? '',
      medicalClearedAt: ob.medicalClearedAt?.toISOString() ?? null,
      /** What the examining officer put forward while it waits centrally. */
      medicalProposed: ob.medicalProposed ?? null,
      medicalSubmittedAt: ob.medicalSubmittedAt?.toISOString() ?? null,
      /**
       * The Central Medical Officer's note.
       *
       * Shown to the examining officer: a candidate reappearing in their queue
       * with no explanation is the most confusing thing this layer could do,
       * and this is the only record of why it came back.
       */
      medicalCmoNote: ob.medicalCmoNote ?? null,
      medicalApprovedAt: ob.medicalApprovedAt?.toISOString() ?? null,
      /** The pre-employment test letter, so HR can see it has gone out. */
      medicalRefNo: ob.medicalRefNo ?? null,
      medicalExamAt: ob.medicalExamAt?.toISOString() ?? null,
      medicalLetterSentAt: ob.medicalLetterSentAt?.toISOString() ?? null,
      medicalLetterTeamSentAt:
        ob.medicalLetterTeamSentAt?.toISOString() ?? null,
      medicalLetterCandidateSentAt:
        ob.medicalLetterCandidateSentAt?.toISOString() ?? null,
      // Whether the clearance came from a paper check rather than the
      // structured report, and who put their name to it.
      // Offer & appointment letters
      offerFormat: ob.offerFormat,
      /** The level settled for this candidate; null until it is chosen. */
      fixedDesignation: ob.fixedDesignation ?? null,
      offerRef: ob.offerRef,
      offerJoiningDate: ob.offerJoiningDate
        ? ob.offerJoiningDate.toISOString().slice(0, 10)
        : null,
      offerJobLocation: ob.offerJobLocation,
      offerProbationMonths: ob.offerProbationMonths,
      offerNoticeDays: ob.offerNoticeDays,
      offerBenefits: ob.offerBenefits ?? [],
      candidateAddress: ob.candidateAddress,
      appointmentRef: ob.appointmentRef,
      appointmentSentAt: ob.appointmentSentAt?.toISOString() ?? null,
      medicalManual: ob.medicalManual,
      medicalClearedByName: ob.medicalClearedBy?.name ?? null,
      // So HR can see the request actually reached the medical team, rather
      // than assuming it did.
      medicalNotifiedAt: ob.medicalNotifiedAt?.toISOString() ?? null,
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
      // Joining documents hold national ID, certificates and photographs, and
      // the Medical Fitness Report is filed here too. None of them is readable
      // on Drive any more; each `url` is a short-lived grant into this API,
      // minted because the caller already passed this record's access check.
      docs: ob.docs.map((d) => ({
        id: d.id,
        label: d.label,
        url:
          this.files.url(
            d.fileId,
            isMedicalDoc(d.label) ? 'medical-report' : 'onboarding-doc',
            { filename: d.label },
          ) ?? d.url,
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

/**
 * Does this document label identify a clinical record?
 *
 * Medical reports are filed as ordinary OnboardingDocs, so the label is what
 * separates "certificate scan" from "hepatitis B result". Deliberately broad:
 * a false positive only means a document is guarded more tightly than it
 * needed to be.
 */
export function isMedicalDoc(label: string): boolean {
  return /medical|health|fitness report|blood|patholog/i.test(label);
}
