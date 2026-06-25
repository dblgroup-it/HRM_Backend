import { Module } from '@nestjs/common';

import { BdJobsService } from './bdjobs.service';
import { BdJobsController } from './bdjobs.controller';

@Module({
  providers: [BdJobsService],
  controllers: [BdJobsController],
  exports: [BdJobsService],
})
export class BdJobsModule {}
