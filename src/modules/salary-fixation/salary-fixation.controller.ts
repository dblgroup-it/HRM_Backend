import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { SalaryFixationService } from './salary-fixation.service';
import { UpsertSalaryFixationDto } from './dto/salary-fixation.dto';

/** Phase 4 — post-interview salary fixation (Corporate HR / CHRO / super only). */
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

  @Post('candidates/:id/salary-fixation/offer')
  markOffered(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.salaryFixation.markOffered(id, user.id);
  }

  @Post('candidates/:id/salary-fixation/finalize')
  finalize(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.salaryFixation.finalize(id, user.id);
  }
}
