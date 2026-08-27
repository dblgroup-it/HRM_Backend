import { Module } from '@nestjs/common';

import { AssessmentService } from './assessment.service';
import { AssessmentController } from './assessment.controller';
import { InterviewService } from './interview.service';
import { InterviewController } from './interview.controller';
import { EvalPublicController } from './eval-public.controller';

@Module({
  providers: [AssessmentService, InterviewService],
  controllers: [AssessmentController, InterviewController, EvalPublicController],
})
export class AssessmentModule {}
