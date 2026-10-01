-- The CHRO may send a requisition on to the board: a BOARD step is appended
-- and each chosen member gets an emailed vote link.
ALTER TYPE "ApprovalRole" ADD VALUE IF NOT EXISTS 'BOARD';

CREATE TABLE "requisition_board_votes" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "status" "BoardVoteStatus" NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requisition_board_votes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "requisition_board_votes_token_hash_key" ON "requisition_board_votes"("token_hash");
CREATE INDEX "requisition_board_votes_requisition_id_idx" ON "requisition_board_votes"("requisition_id");
CREATE INDEX "requisition_board_votes_step_id_idx" ON "requisition_board_votes"("step_id");

ALTER TABLE "requisition_board_votes" ADD CONSTRAINT "requisition_board_votes_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requisition_board_votes" ADD CONSTRAINT "requisition_board_votes_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "approval_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requisition_board_votes" ADD CONSTRAINT "requisition_board_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
