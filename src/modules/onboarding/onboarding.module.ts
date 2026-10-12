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
import { ItAccountRequestService } from './it-account-request.service';
import { ItAccountRequestController } from './it-account-request.controller';
import { ItAccountRequestPublicController } from './it-account-request-public.controller';

@Module({
  // CandidatesModule exports RecruitmentService (Drive workspace builder).
  imports: [CandidatesModule],
  providers: [
    OnboardingService,
    FacilityProvisioningService,
    ItAccountRequestService,
    ReferenceCheckService,
  ],
  controllers: [
    OnboardingController,
    OnboardingPublicController,
    FacilityProvisioningController,
    FacilityProvisioningPublicController,
    ItAccountRequestController,
    ItAccountRequestPublicController,
    ReferenceCheckController,
  ],
})
export class OnboardingModule {}
