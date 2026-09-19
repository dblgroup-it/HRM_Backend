import {
  BadRequestException,
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

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { FileInterceptor } from '@nestjs/platform-express';

import { PDF_UPLOAD } from '../../common/upload/file-upload';
import { SalaryFixationService } from './salary-fixation.service';

/** What multer hands back for the uploaded script. */
interface UploadedSheet {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}
import {
  UpsertSalaryFixationDto,
  UpsertScreeningTestsDto,
} from './dto/salary-fixation.dto';

/** Phase 4 — post-interview salary fixation (Head of Talent Acquisition / CHRO / super only). */
@Controller()
export class SalaryFixationController {
  constructor(private readonly salaryFixation: SalaryFixationService) {}

  @Get('candidates/:id/salary-fixation')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.salaryFixation.get(id, user.id);
  }

  @Patch('candidates/:id/salary-fixation')
  upsert(
    @Param('id') id: string,
    @Body() dto: UpsertSalaryFixationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.salaryFixation.upsert(id, user.id, dto);
  }

  /**
   * Screening-test marks only — reachable by whoever ran the first interview
   * as well as Head of Talent Acquisition, and returning no salary information.
   */
  @Get('candidates/:id/screening-tests')
  getScreeningTests(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.salaryFixation.getScreeningTests(id, user.id);
  }

  @Patch('candidates/:id/screening-tests')
  upsertScreeningTests(
    @Param('id') id: string,
    @Body() dto: UpsertScreeningTestsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.salaryFixation.upsertScreeningTests(id, user.id, dto);
  }

  /**
   * The marked answer script for a hand-marked screening test.
   *
   * `kind` is written | computer. Optional throughout — a mark can still be
   * recorded without one.
   */
  @Post('candidates/:id/screening-tests/:kind/sheet')
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD))
  uploadTestSheet(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: UploadedSheet,
  ) {
    if (kind !== 'written' && kind !== 'computer') {
      throw new BadRequestException('Unknown test');
    }
    return this.salaryFixation.uploadTestSheet(id, user.id, kind, file);
  }

  @Delete('candidates/:id/screening-tests/:kind/sheet')
  removeTestSheet(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @CurrentUser() user: AuthUser,
  ) {
    if (kind !== 'written' && kind !== 'computer') {
      throw new BadRequestException('Unknown test');
    }
    return this.salaryFixation.removeTestSheet(id, user.id, kind);
  }

  @Post('candidates/:id/salary-fixation/offer')
  markOffered(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.salaryFixation.markOffered(id, user.id);
  }

  @Post('candidates/:id/salary-fixation/finalize')
  finalize(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.salaryFixation.finalize(id, user.id);
  }
}
