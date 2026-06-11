import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { Roles } from '../../common/decorators/roles.decorator';
import { GmailIngestService } from './gmail-ingest.service';
import { NudgeService } from './nudge.service';
import { BackupService } from './backup.service';
import { AutomationPauseService } from './automation-pause.service';
import { AutomationLogService } from './automation-log.service';

class PauseDto {
  /** Days to pause for; omit to pause indefinitely. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

/** Manual triggers + pause switches for the scheduled automations (admin only). */
@Roles(UserRole.ADMIN)
@Throttle({ default: { limit: 12, ttl: 60_000 } })
@Controller('automation')
export class AutomationController {
  constructor(
    private readonly gmailIngest: GmailIngestService,
    private readonly nudges: NudgeService,
    private readonly backup: BackupService,
    private readonly pauses: AutomationPauseService,
    private readonly console: AutomationLogService,
  ) {}

  /** Pause state of every scheduled job. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('status')
  status() {
    return this.pauses.getAll();
  }

  /** Rolling console output of cron + manual runs (newest last) — polled. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('logs')
  logs() {
    return { lines: this.console.tail() };
  }

  /** Pause a job for N days (or indefinitely when no days given). */
  @Post(':job/pause')
  pause(@Param('job') job: string, @Body() dto: PauseDto) {
    this.pauses.assertJob(job);
    return this.pauses.pause(job, dto.days);
  }

  @Post(':job/resume')
  resume(@Param('job') job: string) {
    this.pauses.assertJob(job);
    return this.pauses.resume(job);
  }

  /** Scan the recruitment inbox for emailed CVs right now. */
  @Post('gmail-ingest')
  ingest() {
    return this.gmailIngest.ingest();
  }

  /** Send the stale-approval / pending-marks reminders right now. */
  @Post('nudges')
  nudge() {
    return this.nudges.run();
  }

  /** Take a database backup to Drive right now. */
  @Post('backup')
  runBackup() {
    return this.backup.run();
  }
}
