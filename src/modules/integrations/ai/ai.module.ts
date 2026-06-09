import { Global, Module } from '@nestjs/common';

import { AiGraderService } from './ai-grader.service';

/** Global so the exam engine can inject the grader anywhere. */
@Global()
@Module({
  providers: [AiGraderService],
  exports: [AiGraderService],
})
export class AiModule {}
