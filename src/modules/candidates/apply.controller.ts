import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { PDF_UPLOAD as CV_UPLOAD } from '../../common/upload/file-upload';
import { ApplyEmailService } from './apply-email.service';
import { CandidatesService, type UploadedCv } from './candidates.service';
import {
  ApplyEmailCodeDto,
  PublicApplyDto,
  VerifyApplyEmailCodeDto,
} from './dto/candidate.dto';

/**
 * Public, unauthenticated job-application endpoints. The apply page (frontend
 * `/apply/:reqId`) reads the job info and posts the candidate + CV here.
 */
@Controller('apply')
export class ApplyController {
  constructor(
    private readonly candidates: CandidatesService,
    private readonly applyEmail: ApplyEmailService,
  ) {}

  /** List all open (POSTED) positions — powers the /careers page. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('jobs')
  listOpenJobs() {
    return this.candidates.listOpenJobs();
  }

  /** Candidate self-service: look up application status by email. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5/min — limits email enumeration
  @Get('status')
  applicationStatus(@Query('email') email: string) {
    return this.candidates.applicationStatus(email ?? '');
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':reqId')
  async info(@Param('reqId') reqId: string) {
    const [job, verifyEmail] = await Promise.all([
      this.candidates.publicJobInfo(reqId),
      this.applyEmail.required(),
    ]);
    // Tells the page whether to ask for an emailed code before submitting.
    return { ...job, verifyEmail };
  }

  /** Mail a code proving the applicant owns their address. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':reqId/email-code')
  async sendEmailCode(
    @Param('reqId') reqId: string,
    @Body() dto: ApplyEmailCodeDto,
  ) {
    // Only for a post that is open: this is not a way to mail anyone anything.
    const job = await this.candidates.publicJobInfo(reqId);
    return this.applyEmail.sendCode(dto.email, {
      name: dto.name,
      position: job.designation,
    });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':reqId/email-code/verify')
  verifyEmailCode(@Body() dto: VerifyApplyEmailCodeDto) {
    return this.applyEmail.verifyCode(dto.email, dto.code);
  }

  @Public()
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post(':reqId')
  @UseInterceptors(FileInterceptor('cv', CV_UPLOAD))
  async apply(
    @Param('reqId') reqId: string,
    @Body() dto: PublicApplyDto,
    @UploadedFile() cv?: UploadedCv,
  ) {
    // Before anything is stored: the CV must not reach Drive for an
    // address nobody has proved.
    await this.applyEmail.assertVerified(dto.email, dto.emailVerificationToken);
    return this.candidates.publicApply(reqId, dto, cv);
  }
}
