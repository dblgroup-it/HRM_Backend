import { Module } from '@nestjs/common';

import { AssessmentService } from './assessment.service';
import { AssessmentController } from './assessment.controller';
import { InterviewService } from './interview.service';
import { InterviewController } from './interview.controller';
import { ExamService } from './exam.service';
import { ExamController } from './exam.controller';
import { ExamPublicController } from './exam-public.controller';
import { EvalPublicController } from './eval-public.controller';

@Module({
  providers: [AssessmentService, InterviewService, ExamService],
  controllers: [
    AssessmentController,
    InterviewController,
    ExamController,
    ExamPublicController,
    EvalPublicController,
  ],
})
export class AssessmentModule {}
