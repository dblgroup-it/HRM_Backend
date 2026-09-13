-- Medical clearance recorded by hand.
--
-- Clearing currently demands the full structured Medical Fitness Report be
-- filled in. Plenty of checks happen on paper at a clinic, and the officer
-- only needs to record the outcome and attach the signed copy. These columns
-- let that through without pretending a digital form was completed: the
-- clearance is stamped as manual, and says who recorded it.
ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "medical_manual"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "medical_cleared_by_id"  TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'onboardings_medical_cleared_by_id_fkey'
  ) THEN
    ALTER TABLE "onboardings"
      ADD CONSTRAINT "onboardings_medical_cleared_by_id_fkey"
      FOREIGN KEY ("medical_cleared_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
