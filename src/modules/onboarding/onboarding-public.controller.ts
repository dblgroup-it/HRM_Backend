import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import {
  JOINING_DOC_UPLOAD,
  PDF_UPLOAD,
} from '../../common/upload/file-upload';
import { OnboardingService, type UploadedDoc } from './onboarding.service';
import {
  AcceptOfferDto,
  DeclineOfferDto,
  UploadDocDto,
} from './dto/onboarding.dto';

/**
 * Public, unauthenticated onboarding endpoints used by the selected candidate's
 * secure page (`/onboarding/:token`): submit joining documents, accept the offer.
 */
@Controller('onboarding/public')
export class OnboardingPublicController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  info(@Param('token') token: string) {
    return this.onboarding.publicGet(token);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token/docs')
  @UseInterceptors(FileInterceptor('file', JOINING_DOC_UPLOAD))
  upload(
    @Param('token') token: string,
    @Body() dto: UploadDocDto,
    @UploadedFile() file?: UploadedDoc,
  ) {
    return this.onboarding.publicUpload(token, dto.label, file);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':token/accept-offer')
  accept(@Param('token') token: string, @Body() dto: AcceptOfferDto) {
    return this.onboarding.publicAcceptOffer(token, dto.joiningTentative);
  }

  /** The offer letter as a PDF, to print and sign by hand. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token/offer-letter.pdf')
  async offerLetter(@Param('token') token: string, @Res() res: Response) {
    const pdf = await this.onboarding.publicOfferLetterPdf(token);
    if (!pdf) {
      throw new ServiceUnavailableException(
        'The letter could not be produced just now. Please try again shortly.',
      );
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Offer Letter.pdf"');
    res.end(pdf);
  }

  /** Return the signed copy. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/offer-signed')
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD))
  signedOffer(
    @Param('token') token: string,
    @UploadedFile() file?: UploadedDoc,
  ) {
    return this.onboarding.publicUploadSignedOffer(token, file);
  }

  /**
   * Acknowledge the Code of Conduct.
   *
   * No upload — it is signed with the signature already collected among the
   * candidate's joining documents.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/coc')
  signCoc(@Param('token') token: string) {
    return this.onboarding.publicAcknowledgeCoc(token);
  }

  /** Turn the offer down. The reason is required, and HR sees it. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':token/decline-offer')
  decline(@Param('token') token: string, @Body() dto: DeclineOfferDto) {
    return this.onboarding.publicDeclineOffer(token, dto.reason);
  }
}
