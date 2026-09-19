import { Module } from '@nestjs/common';

import { CandidatesModule } from '../candidates/candidates.module';
import { SalaryFixationService } from './salary-fixation.service';
import { SalaryFixationController } from './salary-fixation.controller';

@Module({
  // CandidatesModule exports RecruitmentService — the Drive workspace builder
  // the exam sheet is filed into.
  imports: [CandidatesModule],
  providers: [SalaryFixationService],
  controllers: [SalaryFixationController],
  exports: [SalaryFixationService],
})
export class SalaryFixationModule {}
