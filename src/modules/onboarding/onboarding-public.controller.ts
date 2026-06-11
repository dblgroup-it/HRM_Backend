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
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { DOC_UPLOAD } from '../../common/upload/file-upload';
import { OnboardingService, type UploadedDoc } from './onboarding.service';
import { UploadDocDto } from './dto/onboarding.dto';

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
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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
