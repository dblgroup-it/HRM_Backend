import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { OnboardingService } from './onboarding.service';
import { MedicalDto, NotifyItDto, VerifyDocDto } from './dto/onboarding.dto';

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

  @Post('candidates/:id/onboarding/hr-verify')
  hrVerify(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onboarding.hrVerify(id, user.id);
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
