import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { Public } from '../../common/decorators/public.decorator';
import { OnboardingService, type UploadedDoc } from './onboarding.service';
import { UploadDocDto } from './dto/onboarding.dto';

/** 10 MB cap per joining document. */
const DOC_UPLOAD = { limits: { fileSize: 10 * 1024 * 1024 } };

/**
 * Public, unauthenticated onboarding endpoints used by the selected candidate's
 * secure page (`/onboarding/:token`): submit joining documents, accept the offer.
 */
@Controller('onboarding/public')
export class OnboardingPublicController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Public()
  @Get(':token')
  info(@Param('token') token: string) {
    return this.onboarding.publicGet(token);
  }

  @Public()
  @Post(':token/docs')
  @UseInterceptors(FileInterceptor('file', DOC_UPLOAD))
  upload(
    @Param('token') token: string,
    @Body() dto: UploadDocDto,
    @UploadedFile() file?: UploadedDoc,
  ) {
    return this.onboarding.publicUpload(token, dto.label, file);
  }

  @Public()
  @Post(':token/accept-offer')
  accept(@Param('token') token: string) {
    return this.onboarding.publicAcceptOffer(token);
  }
}
