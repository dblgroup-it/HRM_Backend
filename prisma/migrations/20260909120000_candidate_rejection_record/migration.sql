-- Who rejected a candidate, when, at what point, and why.
--
-- Until now a rejection only reached the free-text `notes` column, so a CV
-- turned down by a factory interviewer after the first interview looked
-- identical to one dropped by Corporate HR at CV screening. These columns make
-- that distinction a fact on the record rather than prose.
ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "rejected_at"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejected_by_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "rejection_stage"  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'candidates_rejected_by_id_fkey'
  ) THEN
    ALTER TABLE "candidates"
      ADD CONSTRAINT "candidates_rejected_by_id_fkey"
      FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "candidates_rejection_stage_idx"
  ON "candidates" ("rejection_stage");
