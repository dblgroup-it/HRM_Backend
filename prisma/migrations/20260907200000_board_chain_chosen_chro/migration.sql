-- The requester also names which CHRO signs the second link, for the same
-- reason Corporate HR is named: the role can be held by more than one person,
-- and mailing them all leaves nobody owning the step.
ALTER TABLE "board_approvals"
  ADD COLUMN IF NOT EXISTS "chro_id" TEXT;

ALTER TABLE "board_approvals"
  DROP CONSTRAINT IF EXISTS "board_approvals_chro_id_fkey";
ALTER TABLE "board_approvals"
  ADD CONSTRAINT "board_approvals_chro_id_fkey"
  FOREIGN KEY ("chro_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
