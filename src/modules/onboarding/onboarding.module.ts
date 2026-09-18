import { Module } from '@nestjs/common';

import { CandidatesModule } from '../candidates/candidates.module';
import { OnboardingService } from './onboarding.service';
import { ReferenceCheckService } from './reference-check.service';
import { ReferenceCheckController } from './reference-check.controller';
import { OnboardingController } from './onboarding.controller';
import { OnboardingPublicController } from './onboarding-public.controller';
import { FacilityProvisioningService } from './facility-provisioning.service';
import { FacilityProvisioningController } from './facility-provisioning.controller';
import { FacilityProvisioningPublicController } from './facility-provisioning-public.controller';

@Module({
  // CandidatesModule exports RecruitmentService (Drive workspace builder).
  imports: [CandidatesModule],
  providers: [
    OnboardingService,
    FacilityProvisioningService,
    ReferenceCheckService,
  ],
  controllers: [
    OnboardingController,
    OnboardingPublicController,
    FacilityProvisioningController,
    FacilityProvisioningPublicController,
    ReferenceCheckController,
  ],
})
export class OnboardingModule {}
