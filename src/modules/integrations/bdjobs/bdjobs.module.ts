import { Module } from '@nestjs/common';

import { BdJobsService } from './bdjobs.service';
import { BdJobsSettingsService } from './bdjobs-settings.service';
import { BdJobsController } from './bdjobs.controller';

@Module({
  providers: [BdJobsService, BdJobsSettingsService],
  controllers: [BdJobsController],
  exports: [BdJobsService, BdJobsSettingsService],
})
export class BdJobsModule {}
