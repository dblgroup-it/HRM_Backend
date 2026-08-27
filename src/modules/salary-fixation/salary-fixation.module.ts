import { Module } from '@nestjs/common';

import { SalaryFixationService } from './salary-fixation.service';
import { SalaryFixationController } from './salary-fixation.controller';

@Module({
  providers: [SalaryFixationService],
  controllers: [SalaryFixationController],
  exports: [SalaryFixationService],
})
export class SalaryFixationModule {}
