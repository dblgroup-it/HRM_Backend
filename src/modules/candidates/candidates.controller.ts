import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { PDF_UPLOAD as CV_UPLOAD } from '../../common/upload/file-upload';
import { CandidatesService, type UploadedCv } from './candidates.service';
import {
  BulkRejectDto,
  CandidateQueryDto,
  CreateCandidateDto,
  EmailCandidateDto,
  UpdateCandidateDto,
} from './dto/candidate.dto';

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

  @Get('candidates/talent-pool')
  talentPool(@CurrentUser() user: AuthUser) {
    return this.candidates.listTalentPool(user.id);
  }

  @Get('requisitions/:reqId/candidates')
  list(
    @Param('reqId') reqId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: CandidateQueryDto,
  ) {
    return this.candidates.list(reqId, user.id, query);
  }

  @Get('requisitions/:reqId/candidates/screening-status')
  screeningStatus(@Param('reqId') reqId: string) {
    return this.candidates.getScreeningStatus(reqId);
  }

  @Get('requisitions/:reqId/candidates/export')
  async exportXlsx(
    @Param('reqId') reqId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: CandidateQueryDto,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.candidates.exportCandidates(
      reqId,
      user.id,
      query,
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Post('requisitions/:reqId/candidates/bulk-reject')
  bulkReject(
    @Param('reqId') reqId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkRejectDto,
  ) {
    return this.candidates.bulkReject(reqId, user.id, dto);
  }

  @Post('requisitions/:reqId/candidates/sync-drive')
  syncDrive(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.candidates.syncFromDrive(reqId, user.id);
  }

  /** AI-screen all un-screened applied CVs in this requisition (non-blocking). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('requisitions/:reqId/candidates/screen')
  screenAll(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.candidates.screenRequisition(reqId, user.id);
  }

  /** AI side-by-side comparison of interview/final-stage candidates. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('requisitions/:reqId/candidates/compare')
  compare(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.candidates.compareFinalists(reqId, user.id);
  }

  /** AI-screen (or re-screen) a single candidate's CV. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('candidates/:id/screen')
  screen(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.candidates.screenCandidate(id, user.id);
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

  @Get('candidates/:id/apply-history')
  applyHistory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.candidates.applyHistory(id, user.id);
  }

  @Patch('candidates/:id/view')
  markViewed(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.candidates.markViewed(id, user.id);
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

  /** One-time admin fix: share all existing private CV files as "anyone with link". */
  @Post('admin/candidates/fix-cv-sharing')
  fixCvSharing(@CurrentUser() user: AuthUser) {
    return this.candidates.backfillCvSharing(user.id);
  }
}
