import { Module } from '@nestjs/common';

import { CandidatesModule } from '../candidates/candidates.module';
import { AssessmentService } from './assessment.service';
import { AssessmentController } from './assessment.controller';
import { InterviewService } from './interview.service';
import { FirstInterviewApprovalService } from './first-interview-approval.service';
import { InterviewController } from './interview.controller';
import { EvalPublicController } from './eval-public.controller';

@Module({
  // For CandidatesService: the interview flow reads a candidate's CV into
  // structured facts so the panel's evaluation form can show a summary.
  imports: [CandidatesModule],
  providers: [
    AssessmentService,
    InterviewService,
    FirstInterviewApprovalService,
  ],
  controllers: [
    AssessmentController,
    InterviewController,
    EvalPublicController,
  ],
})
export class AssessmentModule {}
