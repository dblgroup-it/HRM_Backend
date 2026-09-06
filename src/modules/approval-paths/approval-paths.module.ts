import { Module } from '@nestjs/common';

import { ApprovalPathsService } from './approval-paths.service';
import { ApprovalPathsController } from './approval-paths.controller';

@Module({
  providers: [ApprovalPathsService],
  controllers: [ApprovalPathsController],
  exports: [ApprovalPathsService],
})
export class ApprovalPathsModule {}
