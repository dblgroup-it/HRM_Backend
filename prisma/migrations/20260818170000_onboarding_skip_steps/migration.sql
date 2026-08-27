-- HR can skip waiting on document submission / individual document
-- verification if they decide it's not needed for a given hire.
ALTER TABLE "onboardings" ADD COLUMN "docs_skipped_at" TIMESTAMP(3);
ALTER TABLE "onboardings" ADD COLUMN "verification_skipped_at" TIMESTAMP(3);
