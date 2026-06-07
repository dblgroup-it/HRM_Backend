import { Module } from '@nestjs/common';

import { OrganogramModule } from '../organogram/organogram.module';
import { CandidatesModule } from '../candidates/candidates.module';
import { RequisitionService } from './requisition.service';
import { RequisitionController } from './requisition.controller';

@Module({
  imports: [OrganogramModule, CandidatesModule],
  providers: [RequisitionService],
  controllers: [RequisitionController],
})
export class RequisitionModule {}
