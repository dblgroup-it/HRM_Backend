import { Module } from '@nestjs/common';

import { SalaryFixationModule } from '../salary-fixation/salary-fixation.module';
import { AiProficiencyService } from './ai-proficiency.service';
import { AiProficiencyController } from './ai-proficiency.controller';
import { AiProficiencyPublicController } from './ai-proficiency-public.controller';

@Module({
  imports: [SalaryFixationModule],
  providers: [AiProficiencyService],
  controllers: [AiProficiencyController, AiProficiencyPublicController],
})
export class AiProficiencyModule {}
