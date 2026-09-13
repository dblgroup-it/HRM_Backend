import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingDocStatus, MedicalExam, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import {
  buildAppointmentLetter,
  buildOfferLetter,
  type LetterFormat,
  type LetterInput,
} from './letters';
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
} from './dto/onboarding.dto';

/** Role keys allowed to record medical clearance (configurable / either name). */
export const MEDICAL_ROLE_KEYS = ['medical_officer', 'medical_team'];

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
      html: buildOfferLetter(dto.format, await this.letterInput(cand, ob, dto)),
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

    const input = await this.letterInput(cand, ob, dto);
    const letter = buildOfferLetter(dto.format, input);
    const link = this.publicLink(ob.token);

    await this.mail.send({
      to: cand.email,
      subject: `Offer of employment — ${cand.requisition.designation} | DBL Group`,
      text: `Dear ${cand.name},\n\nPlease find your offer of employment for the position of ${cand.requisition.designation} at ${cand.requisition.unitFactory}, DBL Group.\n\nTo accept and submit your joining documents:\n\n${link}\n\nWarm regards,\nDBL Group Recruitment`,
      // The letter itself is the email body — an offer is a document, not a
      // notification with a link to one.
      html: `${letter}
<div style="font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:18px auto 0;padding:18px 34px;border-top:1px solid #dbe3ec;text-align:center">
  <a href="${link}" style="display:inline-block;background:#1877c0;color:#fff;font-size:14px;font-weight:700;text-decoration:none;padding:12px 30px;border-radius:6px">Accept offer &amp; submit documents</a>
</div>`,
    });

    const updated = await this.prisma.onboarding.update({
      where: { id: ob.id },
      data: {
        offerSentAt: new Date(),
        status: 'offer_sent',
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
    return {
      html: buildAppointmentLetter(
        await this.letterInput(cand, ob, {
          format: 'junior',
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

    const letter = buildAppointmentLetter(
      await this.letterInput(cand, ob, {
        format: 'junior',
        reference: dto.reference,
        joiningDate: dto.joiningDate,
        address: dto.address,
      }),
    );

    await this.mail.send({
      to: cand.email,
      subject: `Appointment letter — ${cand.requisition.designation} | DBL Group`,
      text: `Dear ${cand.name},\n\nPlease find your appointment letter for the position of ${cand.requisition.designation} at ${cand.requisition.unitFactory}, DBL Group.\n\nWarm regards,\nDBL Group`,
      html: letter,
    });

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

  private async letterInput(
    cand: {
      name: string;
      cvProfile?: unknown;
      cvAddress?: string | null;
      requisition: { designation: string; unitFactory: string };
    },
    ob: {
      offerRef: string | null;
      offerJoiningDate: Date | null;
      offerJobLocation: string | null;
      offerProbationMonths: number | null;
      offerNoticeDays: number | null;
      offerBenefits: string[];
      candidateAddress: string | null;
    },
    dto: Partial<OfferLetterDto> & { format: LetterFormat },
  ): Promise<LetterInput> {
    const chro = await this.prisma.roleAssignment.findFirst({
      where: { role: { key: 'chro' } },
      select: { user: { select: { name: true } } },
    });
    return {
      candidateName: cand.name,
      salutation: dto.salutation ?? null,
      address: this.resolveAddress(dto.address, ob.candidateAddress, cand),
      designation: cand.requisition.designation,
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
    if (ob.medicalStatus !== 'cleared') {
      throw new BadRequestException(
        'Medical clearance is required before HR final verification',
      );
    }
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
          // Folders stay private by default (same as every other Drive
          // folder in this app) — grant read access so "Open archive
          // folder" actually opens for whoever clicks it, not just
          // hr.recruitment@.
          this.drive
            .shareAnyoneWithLink(candFolder, 'reader')
            .catch((err) =>
              this.logger.warn(
                `Archive folder share failed for ${candFolder}: ${(err as Error).message}`,
              ),
            );
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

    await this.prisma.onboarding.update({
      where: { id: onboardingId },
      data: {
        medicalStatus: dto.status,
        medicalNote: dto.note ?? null,
        medicalClearedAt: dto.status === 'cleared' ? new Date() : null,
        // A rejection recorded on paper is just as manual as a clearance, and
        // the badge should say so either way.
        medicalManual: dto.status === 'pending' ? false : Boolean(dto.manual),
        medicalClearedById: dto.status === 'pending' ? null : userId,
        status: ob.status === 'offer_accepted' ? 'medical' : ob.status,
      },
    });

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

  /** Medical exam form data is readable by the medical team (who fill it in)
   * and by Head of Talent Acquisition / CHRO (who view the summary on the onboarding page). */
  async getMedicalExam(onboardingId: string, userId: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { id: onboardingId },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');

    const isMedical =
      (await this.permissions.isSuperUser(userId)) ||
      Boolean(
        await this.prisma.roleAssignment.findFirst({
          where: { userId, role: { key: { in: MEDICAL_ROLE_KEYS } } },
        }),
      );
    if (!isMedical) {
      await this.requireRecruitmentAccess(ob.candidate.requisition, userId);
    }

    const exam = await this.prisma.medicalExam.findUnique({
      where: { onboardingId },
    });
    return this.serializeMedicalExam(exam);
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
    return this.serializeMedicalExam(exam);
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
    // Folder stays private by default — grant read access so whoever opens
    // the report link (not just hr.recruitment@) can actually view it.
    this.drive
      .shareAnyoneWithLink(uploaded.id, 'reader')
      .catch((err) =>
        this.logger.warn(
          `Medical report share failed for ${uploaded.id}: ${(err as Error).message}`,
        ),
      );
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
      url: createdDoc.url,
      mimeType: createdDoc.mimeType,
      createdAt: createdDoc.createdAt.toISOString(),
    };
  }

  // --- Public (candidate, by token) ----------------------------------------

  async publicGet(token: string) {
    const ob = await this.prisma.onboarding.findUnique({
      where: { token },
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

  // --- helpers -------------------------------------------------------------

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

  private serializeMedicalExam(exam: MedicalExam | null) {
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
      token: ob.token,
      submissionLink: this.publicLink(ob.token),
      status: ob.status,
      docsSkippedAt: ob.docsSkippedAt?.toISOString() ?? null,
      verificationSkippedAt: ob.verificationSkippedAt?.toISOString() ?? null,
      offerSentAt: ob.offerSentAt?.toISOString() ?? null,
      offerAcceptedAt: ob.offerAcceptedAt?.toISOString() ?? null,
      medicalStatus: ob.medicalStatus,
      medicalNote: ob.medicalNote ?? '',
      medicalClearedAt: ob.medicalClearedAt?.toISOString() ?? null,
      // Whether the clearance came from a paper check rather than the
      // structured report, and who put their name to it.
      // Offer & appointment letters
      offerFormat: ob.offerFormat,
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
