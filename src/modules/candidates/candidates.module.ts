import { Module } from '@nestjs/common';

import { RecruitmentService } from './recruitment.service';
import { CandidatesService } from './candidates.service';
import { CandidatesController } from './candidates.controller';

@Module({
  providers: [RecruitmentService, CandidatesService],
  controllers: [CandidatesController],
  // RecruitmentService is reused by the requisition flow (auto-folders on post).
  exports: [RecruitmentService],
})
export class CandidatesModule {}
