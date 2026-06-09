import { Module } from '@nestjs/common';

import { CandidatesModule } from '../candidates/candidates.module';
import { OnboardingService } from './onboarding.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingPublicController } from './onboarding-public.controller';

@Module({
  // CandidatesModule exports RecruitmentService (Drive workspace builder).
  imports: [CandidatesModule],
  providers: [OnboardingService],
  controllers: [OnboardingController, OnboardingPublicController],
})
export class OnboardingModule {}
