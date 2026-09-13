import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { SalaryFixationService } from './salary-fixation.service';
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

  @Post('candidates/:id/salary-fixation/offer')
  markOffered(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.salaryFixation.markOffered(id, user.id);
  }

  @Post('candidates/:id/salary-fixation/finalize')
  finalize(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.salaryFixation.finalize(id, user.id);
  }
}
