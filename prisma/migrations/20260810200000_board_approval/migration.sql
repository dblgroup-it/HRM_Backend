-- CreateEnum
CREATE TYPE "BoardApprovalStatus" AS ENUM ('pending', 'approved');

-- CreateEnum
CREATE TYPE "BoardVoteStatus" AS ENUM ('pending', 'approved');

-- CreateTable
CREATE TABLE "board_groups" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "board_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_group_members" (
    "group_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "board_group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "board_approvals" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "status" "BoardApprovalStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "board_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_approval_votes" (
    "id" TEXT NOT NULL,
    "board_approval_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "status" "BoardVoteStatus" NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "responded_at" TIMESTAMP(3),
    CONSTRAINT "board_approval_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "board_approval_votes_token_key" ON "board_approval_votes"("token");

-- AddForeignKey
ALTER TABLE "board_group_members" ADD CONSTRAINT "board_group_members_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "board_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "board_group_members" ADD CONSTRAINT "board_group_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "board_approvals" ADD CONSTRAINT "board_approvals_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "board_approvals" ADD CONSTRAINT "board_approvals_requested_by_id_fkey"
    FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "board_approval_votes" ADD CONSTRAINT "board_approval_votes_board_approval_id_fkey"
    FOREIGN KEY ("board_approval_id") REFERENCES "board_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "board_approval_votes" ADD CONSTRAINT "board_approval_votes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
