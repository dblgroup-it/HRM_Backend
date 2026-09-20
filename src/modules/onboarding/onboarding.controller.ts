import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { DOC_UPLOAD } from '../../common/upload/file-upload';
import { OnboardingService, type UploadedDoc } from './onboarding.service';
import {
  ManualCrossCheckDto,
  MedicalDto,
  MedicalExamDto,
  NotifyItDto,
  VerifyDocDto,
  OfferLetterDto,
  AppointmentLetterDto,
  SetFixedDesignationDto,
  MedicalDecisionDto,
  MedicalDecisionBulkDto,
  SendMedicalLetterDto,
  EmployeeIdDto,
} from './dto/onboarding.dto';

/** Phase 4 & 5 — document verification, offer & onboarding (authenticated HR). */
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  // Medical-officer dashboard (static routes first).
  @Get('onboarding/medical-queue')
  medicalQueue(@CurrentUser() user: AuthUser) {
    return this.onboarding.medicalQueue(user.id);
  }

  /** Ask the medical team to look at this candidate (or remind them). */
  @Post('onboarding/:id/alert-medical')
  alertMedical(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.alertMedicalTeam(id, user.id);
  }

  @Patch('onboarding/:id/medical')
  setMedical(
    @Param('id') id: string,
    @Body() dto: MedicalDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.setMedical(id, dto, user.id);
  }

  @Get('onboarding/:id/medical-exam')
  getMedicalExam(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.getMedicalExam(id, user.id);
  }

  @Patch('onboarding/:id/medical-exam')
  upsertMedicalExam(
    @Param('id') id: string,
    @Body() dto: MedicalExamDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.upsertMedicalExam(id, dto, user.id);
  }

  @Post('onboarding/:id/medical-report')
  @UseInterceptors(FileInterceptor('file', DOC_UPLOAD))
  uploadMedicalReport(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: UploadedDoc,
  ) {
    return this.onboarding.uploadMedicalReport(id, file, user.id);
  }

  // Per-document actions.
  @Post('onboarding/docs/:docId/summarize')
  summarizeDoc(@Param('docId') docId: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.summarizeDoc(docId, user.id);
  }

  /**
   * The document itself. Ordinary joining documents need recruitment access;
   * anything clinical needs a medical role — enforced in the service.
   */
  @Get('onboarding/docs/:docId/file')
  docFile(
    @Param('docId') docId: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    return this.onboarding.streamDoc(docId, user.id, res);
  }

  /** The Medical Fitness Report — medical roles only. */
  @Get('onboarding/:id/medical-report/file')
  medicalReportFile(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    return this.onboarding.streamMedicalReport(id, user.id, res);
  }

  @Patch('onboarding/docs/:docId/verify')
  verifyDoc(
    @Param('docId') docId: string,
    @Body() dto: VerifyDocDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.verifyDoc(docId, dto.status, user.id);
  }

  /** What the send screen needs: suggested band, reference, venue, appointment. */
  @Get('onboarding/:id/medical-letter')
  medicalLetterDraft(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.medicalLetterDraft(id, user.id);
  }

  /**
   * Send the pre-employment medical test letter.
   *
   * Two emails: the letter to the clinic, and where/when/what-to-bring to the
   * candidate. Returns which addresses took it and which did not, rather than
   * failing the whole send because one bounced.
   */
  @Post('onboarding/:id/medical-letter')
  sendMedicalLetter(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SendMedicalLetterDto,
  ) {
    return this.onboarding.sendMedicalTestLetter(id, user.id, dto);
  }

  // ── Central Medical Officer ───────────────────────────────────────────────

  /**
   * Everything waiting on the Central Medical Officer, oldest first.
   *
   * Distinct from `onboarding/medical-queue`, which is the examining officer's
   * list of candidates still needing an exam. This one is findings already
   * made, waiting to be confirmed.
   */
  @Get('medical-approvals')
  medicalApprovalQueue(@CurrentUser() user: AuthUser) {
    return this.onboarding.medicalApprovalQueue(user.id);
  }

  /** Confirm, overturn or return one submitted finding. */
  @Post('medical-approvals/:onboardingId/decide')
  decideMedical(
    @Param('onboardingId') onboardingId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: MedicalDecisionDto,
  ) {
    return this.onboarding.decideMedical(onboardingId, user.id, dto);
  }

  /**
   * The same verdict across a selection.
   *
   * Always 200 with a per-record result: a bulk approval is a list of
   * independent decisions, and one row another CMO handled a moment earlier
   * must not fail the rest.
   */
  @Post('medical-approvals/decide')
  decideMedicalMany(
    @CurrentUser() user: AuthUser,
    @Body() dto: MedicalDecisionBulkDto,
  ) {
    return this.onboarding.decideMedicalMany(user.id, dto);
  }

  // Per-candidate lifecycle.
  @Get('candidates/:id/onboarding')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.getByCandidate(id, user.id);
  }

  @Post('candidates/:id/onboarding')
  start(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.start(id, user.id);
  }

  /**
   * Settle the level this candidate is hired at.
   *
   * Applies immediately rather than when a letter is next rendered, because
   * the choice changes what every screen calls this person.
   */
  @Patch('candidates/:id/onboarding/designation')
  setDesignation(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SetFixedDesignationDto,
  ) {
    return this.onboarding.setFixedDesignation(id, user.id, dto.designation);
  }

  @Post('candidates/:id/onboarding/send-link')
  sendLink(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.sendLink(id, user.id);
  }

  /** Render the offer letter for review, without sending it. */
  @Post('candidates/:id/onboarding/offer/preview')
  previewOffer(
    @Param('id') id: string,
    @Body() dto: OfferLetterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.previewOfferLetter(id, user.id, dto);
  }

  @Post('candidates/:id/onboarding/offer')
  sendOffer(
    @Param('id') id: string,
    @Body() dto: OfferLetterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.sendOffer(id, user.id, dto);
  }

  /** The appointment letter, once final verification is done. */
  @Post('candidates/:id/onboarding/appointment-letter/preview')
  previewAppointment(
    @Param('id') id: string,
    @Body() dto: AppointmentLetterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.previewAppointmentLetter(id, user.id, dto);
  }

  @Post('candidates/:id/onboarding/appointment-letter')
  sendAppointment(
    @Param('id') id: string,
    @Body() dto: AppointmentLetterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.sendAppointmentLetter(id, user.id, dto);
  }

  /** Settle the placement — employee ID and reporting line. */
  @Patch('candidates/:id/onboarding/employee-id')
  setEmployeeId(
    @Param('id') id: string,
    @Body() dto: EmployeeIdDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.setEmployeeId(id, user.id, dto);
  }

  /** Who HR may issue this candidate's letters over (CHRO role holders). */
  @Get('candidates/:id/onboarding/signatories')
  letterSignatories(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.letterSignatories(id, user.id);
  }

  /** Send the Code of Conduct acknowledgement for the candidate to sign. */
  @Post('candidates/:id/onboarding/coc/send')
  sendCoc(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.sendCoc(id, user.id);
  }

  /** HR marks the offer accepted by hand (candidate confirmed in person / by phone). */
  @Post('candidates/:id/onboarding/offer/mark-accepted')
  markOfferAcceptedManually(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.markOfferAcceptedManually(id, user.id);
  }

  /** AI cross-verification of all extracted docs vs the candidate's profile. */
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('candidates/:id/onboarding/cross-check')
  crossCheck(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.crossVerify(id, user.id);
  }

  /** Manual alternative — HR records their own verdict, no AI required. */
  @Post('candidates/:id/onboarding/cross-check/manual')
  manualCrossCheck(
    @Param('id') id: string,
    @Body() dto: ManualCrossCheckDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.manualCrossCheck(id, dto, user);
  }

  @Post('candidates/:id/onboarding/hr-verify')
  hrVerify(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.hrVerify(id, user.id);
  }

  @Post('candidates/:id/onboarding/skip-docs')
  skipDocs(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.skipDocs(id, user.id);
  }

  @Post('candidates/:id/onboarding/skip-verification')
  skipVerification(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.skipVerification(id, user.id);
  }

  /** HR has been through this hire's facility entitlements — unlocks medical. */
  @Post('candidates/:id/onboarding/facilities/review')
  reviewFacilities(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.reviewFacilities(id, user.id);
  }

  @Post('candidates/:id/onboarding/archive')
  archive(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.archive(id, user.id);
  }

  @Post('candidates/:id/onboarding/notify-it')
  notifyIt(
    @Param('id') id: string,
    @Body() dto: NotifyItDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.notifyIt(id, dto, user.id);
  }
}
