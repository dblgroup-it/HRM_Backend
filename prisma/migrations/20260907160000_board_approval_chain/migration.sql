-- Board approval becomes a sequential chain.
--
-- Corporate Recruiter → Corporate HR → CHRO → Board group, each step confirmed
-- by its own emailed one-time link. Whoever starts it skips their own step.
--
-- Board members are chosen up front but only emailed once the CHRO has signed
-- off, so the selection is parked on the approval until then.

CREATE TYPE "BoardApprovalStage" AS ENUM ('corporate_hr', 'chro', 'board');

-- Approve-only until now; a step needs a way to say no.
ALTER TYPE "BoardVoteStatus" ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE "BoardApprovalStatus" ADD VALUE IF NOT EXISTS 'rejected';

ALTER TABLE "board_approval_votes"
  ADD COLUMN IF NOT EXISTS "stage" "BoardApprovalStage" NOT NULL DEFAULT 'board';

ALTER TABLE "board_approvals"
  ADD COLUMN IF NOT EXISTS "current_stage" "BoardApprovalStage" NOT NULL DEFAULT 'board',
  ADD COLUMN IF NOT EXISTS "board_member_ids" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "rejected_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "board_approval_votes_stage_idx"
  ON "board_approval_votes" ("board_approval_id", "stage");
