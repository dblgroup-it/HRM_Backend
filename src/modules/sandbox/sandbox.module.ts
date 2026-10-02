import { Global, Module } from '@nestjs/common';

import { SandboxController } from './sandbox.controller';
import { PromoteService } from './promote.service';
import { SandboxService } from './sandbox.service';

/** Global, so every integration can ask it before reaching outside. */
@Global()
@Module({
  providers: [SandboxService, PromoteService],
  controllers: [SandboxController],
  exports: [SandboxService],
})
export class SandboxModule {}
