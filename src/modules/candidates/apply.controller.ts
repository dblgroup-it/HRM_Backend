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
import { CandidatesService, type UploadedCv } from './candidates.service';
import { PublicApplyDto } from './dto/candidate.dto';

const CV_UPLOAD = { limits: { fileSize: 10 * 1024 * 1024 } };

/**
 * Public, unauthenticated job-application endpoints. The apply page (frontend
 * `/apply/:reqId`) reads the job info and posts the candidate + CV here.
 */
@Controller('apply')
export class ApplyController {
  constructor(private readonly candidates: CandidatesService) {}

  @Public()
  @Get(':reqId')
  info(@Param('reqId') reqId: string) {
    return this.candidates.publicJobInfo(reqId);
  }

  @Public()
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
