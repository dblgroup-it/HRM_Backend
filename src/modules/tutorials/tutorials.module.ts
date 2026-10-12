import { Module } from '@nestjs/common';

import { TutorialsController } from './tutorials.controller';
import { TutorialsService } from './tutorials.service';

@Module({
  providers: [TutorialsService],
  controllers: [TutorialsController],
})
export class TutorialsModule {}
