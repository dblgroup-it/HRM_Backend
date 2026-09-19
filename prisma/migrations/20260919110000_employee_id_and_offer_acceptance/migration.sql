-- The DBL employee ID the recruiter assigns to a candidate, and what the
-- candidate gives back when accepting: a tentative joining date and the copy
-- of the offer they signed by hand.
ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "employee_id" VARCHAR(30);

ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "offer_joining_tentative" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "offer_signed_file_id" TEXT,
  ADD COLUMN IF NOT EXISTS "offer_signed_url" TEXT;
