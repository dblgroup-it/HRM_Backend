import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { ZingHrService } from './zinghr.service';

@Controller('integrations/zinghr')
export class ZingHrController {
  constructor(private readonly zinghr: ZingHrService) {}

  /** Start a sync (non-blocking). Returns the run record to poll. */
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Post('sync')
  @HttpCode(202)
  sync() {
    return this.zinghr.startSync();
  }

  /** Live status of the latest run (polled by the UI). */
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Get('sync/status')
  status() {
    return this.zinghr.getStatus();
  }

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Get('logs')
  logs(@Query('take') take?: string) {
    return this.zinghr.getLogs(take ? Number(take) : 20);
  }
}
