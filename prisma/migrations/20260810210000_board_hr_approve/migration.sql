-- Add HR manual approval fields to board_approvals
ALTER TABLE "board_approvals" ADD COLUMN "hr_approved_by_id" TEXT;
ALTER TABLE "board_approvals" ADD COLUMN "hr_approval_note"  VARCHAR(500);
ALTER TABLE "board_approvals" ADD COLUMN "hr_approved_at"    TIMESTAMP(3);

ALTER TABLE "board_approvals"
  ADD CONSTRAINT "board_approvals_hr_approved_by_id_fkey"
  FOREIGN KEY ("hr_approved_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
