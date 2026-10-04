import { Module } from '@nestjs/common';

import { RecruitmentService } from './recruitment.service';
import { CandidatesService } from './candidates.service';
import { CandidateMailService } from './candidate-mail.service';
import { CandidatesController } from './candidates.controller';
import { ApplyController } from './apply.controller';

@Module({
  providers: [RecruitmentService, CandidatesService, CandidateMailService],
  controllers: [CandidatesController, ApplyController],
  // RecruitmentService is reused by the requisition flow (auto-folders on post);
  // CandidatesService by the automation module (Gmail CV ingestion);
  // CandidateMailService by interviews, for the regret letter.
  exports: [RecruitmentService, CandidatesService, CandidateMailService],
})
export class CandidatesModule {}
