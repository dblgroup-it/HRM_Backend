import { Module } from '@nestjs/common';

import { OrganogramModule } from '../organogram/organogram.module';
import { CandidatesModule } from '../candidates/candidates.module';
import { ApprovalPathsModule } from '../approval-paths/approval-paths.module';
import { MasterDataModule } from '../master-data/master-data.module';
import { RequisitionService } from './requisition.service';
import { RequisitionController } from './requisition.controller';
import { RequisitionBoardService } from './requisition-board.service';
import { RequisitionBoardPublicController } from './requisition-board-public.controller';

@Module({
  imports: [
    OrganogramModule,
    CandidatesModule,
    ApprovalPathsModule,
    MasterDataModule,
  ],
  providers: [RequisitionService, RequisitionBoardService],
  controllers: [RequisitionController, RequisitionBoardPublicController],
})
export class RequisitionModule {}
