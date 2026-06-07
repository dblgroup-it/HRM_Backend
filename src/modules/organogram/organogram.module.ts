import { Module } from '@nestjs/common';

import { OrganogramService } from './organogram.service';
import { OrganogramController } from './organogram.controller';

@Module({
  providers: [OrganogramService],
  controllers: [OrganogramController],
  exports: [OrganogramService],
})
export class OrganogramModule {}
