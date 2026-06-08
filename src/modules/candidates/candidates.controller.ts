import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { CandidatesService, type UploadedCv } from './candidates.service';
import {
  CreateCandidateDto,
  EmailCandidateDto,
  UpdateCandidateDto,
} from './dto/candidate.dto';

/** 10 MB cap per CV upload. */
const CV_UPLOAD = { limits: { fileSize: 10 * 1024 * 1024 } };

@Controller()
export class CandidatesController {
  constructor(private readonly candidates: CandidatesService) {}

  @Get('requisitions/:reqId/recruitment')
  workspace(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.candidates.getWorkspace(reqId, user.id);
  }

  @Post('requisitions/:reqId/recruitment/setup')
  setup(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.candidates.setupWorkspace(reqId, user.id);
  }

  @Get('requisitions/:reqId/candidates')
  list(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.candidates.list(reqId, user.id);
  }

  @Post('requisitions/:reqId/candidates/sync-drive')
  syncDrive(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.candidates.syncFromDrive(reqId, user.id);
  }

  @Post('requisitions/:reqId/candidates')
  @UseInterceptors(FileInterceptor('cv', CV_UPLOAD))
  create(
    @Param('reqId') reqId: string,
    @Body() dto: CreateCandidateDto,
    @CurrentUser() user: AuthUser,
    @UploadedFile() cv?: UploadedCv,
  ) {
    return this.candidates.create(reqId, dto, user.id, cv);
  }

  @Patch('candidates/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCandidateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.candidates.update(id, dto, user.id);
  }

  @Post('candidates/:id/cv')
  @UseInterceptors(FileInterceptor('cv', CV_UPLOAD))
  uploadCv(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() cv: UploadedCv,
  ) {
    return this.candidates.uploadCv(id, user.id, cv);
  }

  @Post('candidates/:id/email')
  email(
    @Param('id') id: string,
    @Body() dto: EmailCandidateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.candidates.emailCandidate(id, user.id, dto);
  }

  @Delete('candidates/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.candidates.remove(id, user.id);
  }
}
