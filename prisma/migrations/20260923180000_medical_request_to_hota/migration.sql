-- The medical test letter now goes through Head of Talent Acquisition.
--
-- The recruiter used to send it straight to the clinic and the candidate. Now
-- they only ask for it — test list, salutation, reference — and the request
-- waits in Head of Talent Acquisition's inbox, who sets the date and venue for
-- each candidate and sends the letters, one email per candidate.

ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "medical_salutation" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "medical_request_pending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "medical_requested_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "medical_requested_by_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'onboardings_medical_requested_by_id_fkey'
  ) THEN
    ALTER TABLE "onboardings"
      ADD CONSTRAINT "onboardings_medical_requested_by_id_fkey"
      FOREIGN KEY ("medical_requested_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "onboardings_medical_request_pending_idx"
  ON "onboardings" ("medical_request_pending")
  WHERE "medical_request_pending";
