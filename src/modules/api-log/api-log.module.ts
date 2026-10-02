import { Global, Module } from '@nestjs/common';

import { ApiLogController } from './api-log.controller';
import { ApiLogService } from './api-log.service';

@Global()
@Module({
  providers: [ApiLogService],
  controllers: [ApiLogController],
  exports: [ApiLogService],
})
export class ApiLogModule {}
