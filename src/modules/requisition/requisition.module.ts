import { Module } from '@nestjs/common';

import { OrganogramModule } from '../organogram/organogram.module';
import { RequisitionService } from './requisition.service';
import { RequisitionController } from './requisition.controller';

@Module({
  imports: [OrganogramModule],
  providers: [RequisitionService],
  controllers: [RequisitionController],
})
export class RequisitionModule {}
