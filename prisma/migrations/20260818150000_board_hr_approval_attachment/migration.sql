-- HR approving on the board's behalf now requires a justifying attachment
-- (uploaded to Drive); a real board member's own vote does not need one.
ALTER TABLE "board_approvals" ADD COLUMN "hr_approval_attachment_file_id" TEXT;
ALTER TABLE "board_approvals" ADD COLUMN "hr_approval_attachment_url" TEXT;
ALTER TABLE "board_approvals" ADD COLUMN "hr_approval_attachment_name" TEXT;
