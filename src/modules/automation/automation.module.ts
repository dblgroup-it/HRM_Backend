import { Module } from '@nestjs/common';

import { CandidatesModule } from '../candidates/candidates.module';
import { GmailIngestService } from './gmail-ingest.service';
import { NudgeService } from './nudge.service';
import { BackupService } from './backup.service';
import { AutomationPauseService } from './automation-pause.service';
import { AutomationLogService } from './automation-log.service';
import { AutomationController } from './automation.controller';

/**
 * Scheduled automations: emailed-CV ingestion (15 min), approval/marks nudges
 * (daily 09:30) and the nightly DB backup to Drive (02:30) — plus admin
 * endpoints to trigger each on demand.
 */
@Module({
  // Permissions/Notifications/Google services come from @Global modules.
  imports: [CandidatesModule],
  providers: [
    GmailIngestService,
    NudgeService,
    BackupService,
    AutomationPauseService,
    AutomationLogService,
  ],
  controllers: [AutomationController],
})
export class AutomationModule {}
