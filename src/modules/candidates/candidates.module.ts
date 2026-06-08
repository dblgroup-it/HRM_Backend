import { Module } from '@nestjs/common';

import { RecruitmentService } from './recruitment.service';
import { CandidatesService } from './candidates.service';
import { CandidatesController } from './candidates.controller';
import { ApplyController } from './apply.controller';

@Module({
  providers: [RecruitmentService, CandidatesService],
  controllers: [CandidatesController, ApplyController],
  // RecruitmentService is reused by the requisition flow (auto-folders on post).
  exports: [RecruitmentService],
})
export class CandidatesModule {}
