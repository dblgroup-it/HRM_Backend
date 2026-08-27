import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
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

  @Patch('onboarding/docs/:docId/verify')
  verifyDoc(
    @Param('docId') docId: string,
    @Body() dto: VerifyDocDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.verifyDoc(docId, dto.status, user.id);
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

  @Post('candidates/:id/onboarding/send-link')
  sendLink(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.sendLink(id, user.id);
  }

  @Post('candidates/:id/onboarding/offer')
  sendOffer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.sendOffer(id, user.id);
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
