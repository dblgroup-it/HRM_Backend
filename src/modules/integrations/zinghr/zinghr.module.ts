import { Module } from '@nestjs/common';

import { ZingHrService } from './zinghr.service';
import { ZingHrController } from './zinghr.controller';

@Module({
  providers: [ZingHrService],
  controllers: [ZingHrController],
  exports: [ZingHrService],
})
export class ZingHrModule {}
