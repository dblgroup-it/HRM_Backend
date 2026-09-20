-- Who signs the letter, how the candidate signs it back, and who they report to.
--
-- 1. The CHRO is chosen per letter instead of being whichever role assignment
--    came back first, so a letter names the person who actually signed it.
-- 2. Accepting online now produces a counter-signed copy of the offer, filed
--    with the joining documents. Kept apart from offer_signed_*, which is a
--    scan the candidate posts back by hand — either, both or neither exists.
-- 3. The line manager is settled alongside the employee ID when the placement
--    is confirmed, as a name/code snapshot like Employee.line_manager_*.

ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "offer_signatory_id" TEXT,
  ADD COLUMN IF NOT EXISTS "appointment_signatory_id" TEXT,
  ADD COLUMN IF NOT EXISTS "offer_accepted_file_id" TEXT,
  ADD COLUMN IF NOT EXISTS "offer_accepted_url" TEXT;

ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "line_manager_name" VARCHAR(150),
  ADD COLUMN IF NOT EXISTS "line_manager_code" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "line_manager_title" VARCHAR(150);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'onboardings_offer_signatory_id_fkey') THEN
    ALTER TABLE "onboardings"
      ADD CONSTRAINT "onboardings_offer_signatory_id_fkey"
      FOREIGN KEY ("offer_signatory_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'onboardings_appointment_signatory_id_fkey') THEN
    ALTER TABLE "onboardings"
      ADD CONSTRAINT "onboardings_appointment_signatory_id_fkey"
      FOREIGN KEY ("appointment_signatory_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "onboardings_offer_signatory_id_idx"
  ON "onboardings" ("offer_signatory_id");
CREATE INDEX IF NOT EXISTS "onboardings_appointment_signatory_id_idx"
  ON "onboardings" ("appointment_signatory_id");
