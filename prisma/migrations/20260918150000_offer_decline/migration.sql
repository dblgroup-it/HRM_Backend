-- The candidate can turn an offer down, with a reason HR can act on.
--
-- Separate nullable columns rather than a new OnboardingStatus value: nothing
-- reads a status that does not exist yet, every `offer_accepted_at IS NOT NULL`
-- check keeps its meaning, and a row can never be both accepted and declined.
ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "offer_declined_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "offer_decline_reason" TEXT;
