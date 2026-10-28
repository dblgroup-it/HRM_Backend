import { Global, Module } from '@nestjs/common';

import { AiGraderService } from './ai-grader.service';
import { AiProviderConfigService } from './ai-provider-config.service';

/** Global so the exam engine can inject the grader anywhere. */
@Global()
@Module({
  providers: [AiProviderConfigService, AiGraderService],
  exports: [AiProviderConfigService, AiGraderService],
})
export class AiModule {}
