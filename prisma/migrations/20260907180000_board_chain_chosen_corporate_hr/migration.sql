-- The recruiter names which Corporate HR should sign off.
--
-- Corporate HR is held by several people, so mailing every holder made the
-- first link of the chain ambiguous — nobody owns it. The requester picks one
-- when raising the request, and only that person is asked.
ALTER TABLE "board_approvals"
  ADD COLUMN IF NOT EXISTS "corporate_hr_id" TEXT;

ALTER TABLE "board_approvals"
  DROP CONSTRAINT IF EXISTS "board_approvals_corporate_hr_id_fkey";
ALTER TABLE "board_approvals"
  ADD CONSTRAINT "board_approvals_corporate_hr_id_fkey"
  FOREIGN KEY ("corporate_hr_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
