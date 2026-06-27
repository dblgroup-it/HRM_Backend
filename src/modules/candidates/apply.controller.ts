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
import { CandidatesService, type UploadedCv } from './candidates.service';
import { PublicApplyDto } from './dto/candidate.dto';

/**
 * Public, unauthenticated job-application endpoints. The apply page (frontend
 * `/apply/:reqId`) reads the job info and posts the candidate + CV here.
 */
@Controller('apply')
export class ApplyController {
  constructor(private readonly candidates: CandidatesService) {}

  /** List all open (POSTED) positions — powers the /careers page. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('jobs')
  listOpenJobs() {
    return this.candidates.listOpenJobs();
  }

  /** Candidate self-service: look up application status by email. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })   // 5/min — limits email enumeration
  @Get('status')
  applicationStatus(@Query('email') email: string) {
    return this.candidates.applicationStatus(email ?? '');
  }

  @Public()
  @Get(':reqId')
  info(@Param('reqId') reqId: string) {
    return this.candidates.publicJobInfo(reqId);
  }

  @Public()
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post(':reqId')
  @UseInterceptors(FileInterceptor('cv', CV_UPLOAD))
  apply(
    @Param('reqId') reqId: string,
    @Body() dto: PublicApplyDto,
    @UploadedFile() cv?: UploadedCv,
  ) {
    return this.candidates.publicApply(reqId, dto, cv);
  }
}
