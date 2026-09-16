import { Module } from '@nestjs/common';

import { BdJobsService } from './bdjobs.service';
import { BdJobsSettingsService } from './bdjobs-settings.service';
import { BdJobsController } from './bdjobs.controller';
import { CandidatesModule } from '../../candidates/candidates.module';

@Module({
  // Inbound applications are screened and broadcast by the candidates module,
  // so an application from Bdjobs behaves like one collected from Drive.
  imports: [CandidatesModule],
  providers: [BdJobsService, BdJobsSettingsService],
  controllers: [BdJobsController],
  exports: [BdJobsService, BdJobsSettingsService],
})
export class BdJobsModule {}
