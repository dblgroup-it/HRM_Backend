-- 13.3 Convert onboarding status fields to typed enums.
-- 14.2 Convert onboarding_docs status to typed enum.

CREATE TYPE "OnboardingStatus" AS ENUM (
  'docs_pending', 'docs_submitted', 'offer_sent',
  'offer_accepted', 'medical', 'hr_final', 'onboarded'
);

CREATE TYPE "MedicalStatus" AS ENUM ('pending', 'cleared', 'rejected');

CREATE TYPE "OnboardingDocStatus" AS ENUM ('pending', 'verified', 'rejected');

-- onboardings.status
ALTER TABLE "onboardings" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "onboardings" ALTER COLUMN "status" TYPE "OnboardingStatus" USING "status"::"OnboardingStatus";
ALTER TABLE "onboardings" ALTER COLUMN "status" SET DEFAULT 'docs_pending'::"OnboardingStatus";

-- onboardings.medical_status
ALTER TABLE "onboardings" ALTER COLUMN "medical_status" DROP DEFAULT;
ALTER TABLE "onboardings" ALTER COLUMN "medical_status" TYPE "MedicalStatus" USING "medical_status"::"MedicalStatus";
ALTER TABLE "onboardings" ALTER COLUMN "medical_status" SET DEFAULT 'pending'::"MedicalStatus";

-- onboarding_docs.status
ALTER TABLE "onboarding_docs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "onboarding_docs" ALTER COLUMN "status" TYPE "OnboardingDocStatus" USING "status"::"OnboardingDocStatus";
ALTER TABLE "onboarding_docs" ALTER COLUMN "status" SET DEFAULT 'pending'::"OnboardingDocStatus";
