-- Hiring Approval Sheets: batch the board chain from Corporate HR onward.
--
-- The recruiter still forwards candidates one at a time. Corporate HR then
-- gathers whoever is waiting onto one sheet and sends it to the CHRO and the
-- board together, mirroring DBL's paper "Hiring Approval Sheet" — one email,
-- one table, one decision, instead of a mail per candidate.
CREATE TABLE IF NOT EXISTS "board_approval_batches" (
  "id"               TEXT NOT NULL,
  "reference"        VARCHAR(30) NOT NULL,
  "created_by_id"    TEXT NOT NULL,
  "status"           "BoardApprovalStatus" NOT NULL DEFAULT 'pending',
  "current_stage"    "BoardApprovalStage" NOT NULL DEFAULT 'chro',
  "chro_id"          TEXT,
  "board_member_ids" TEXT[],
  "rejected_reason"  TEXT,
  "rejected_at"      TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "board_approval_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "board_approval_batches_reference_key"
  ON "board_approval_batches" ("reference");

ALTER TABLE "board_approvals"
  ADD COLUMN IF NOT EXISTS "batch_id" TEXT;
CREATE INDEX IF NOT EXISTS "board_approvals_batch_id_idx"
  ON "board_approvals" ("batch_id");

-- A vote is cast either on one candidate's approval or on a whole sheet, so
-- the existing column has to allow NULL. Widening only — no data is touched.
ALTER TABLE "board_approval_votes"
  ALTER COLUMN "board_approval_id" DROP NOT NULL;
ALTER TABLE "board_approval_votes"
  ADD COLUMN IF NOT EXISTS "batch_id" TEXT;
CREATE INDEX IF NOT EXISTS "board_approval_votes_batch_id_idx"
  ON "board_approval_votes" ("batch_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_approval_batches_created_by_id_fkey') THEN
    ALTER TABLE "board_approval_batches" ADD CONSTRAINT "board_approval_batches_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_approval_batches_chro_id_fkey') THEN
    ALTER TABLE "board_approval_batches" ADD CONSTRAINT "board_approval_batches_chro_id_fkey"
      FOREIGN KEY ("chro_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_approvals_batch_id_fkey') THEN
    ALTER TABLE "board_approvals" ADD CONSTRAINT "board_approvals_batch_id_fkey"
      FOREIGN KEY ("batch_id") REFERENCES "board_approval_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_approval_votes_batch_id_fkey') THEN
    ALTER TABLE "board_approval_votes" ADD CONSTRAINT "board_approval_votes_batch_id_fkey"
      FOREIGN KEY ("batch_id") REFERENCES "board_approval_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
