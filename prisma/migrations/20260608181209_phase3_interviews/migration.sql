-- CreateEnum
CREATE TYPE "InterviewKind" AS ENUM ('FIRST', 'SECOND', 'FINAL');

-- CreateEnum
CREATE TYPE "InterviewMode" AS ENUM ('ONLINE', 'OFFLINE', 'PHYSICAL');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "interview_rounds" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "kind" "InterviewKind" NOT NULL DEFAULT 'FIRST',
    "mode" "InterviewMode" NOT NULL DEFAULT 'PHYSICAL',
    "scheduled_at" TIMESTAMP(3),
    "location" TEXT,
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_panelists" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "interview_panelists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL,
    "scores" JSONB NOT NULL,
    "comments" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interview_rounds_candidate_id_idx" ON "interview_rounds"("candidate_id");

-- CreateIndex
CREATE INDEX "interview_rounds_requisition_id_idx" ON "interview_rounds"("requisition_id");

-- CreateIndex
CREATE INDEX "interview_panelists_user_id_idx" ON "interview_panelists"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_panelists_round_id_user_id_key" ON "interview_panelists"("round_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "evaluations_round_id_evaluator_id_key" ON "evaluations"("round_id", "evaluator_id");

-- AddForeignKey
ALTER TABLE "interview_rounds" ADD CONSTRAINT "interview_rounds_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_rounds" ADD CONSTRAINT "interview_rounds_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_panelists" ADD CONSTRAINT "interview_panelists_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "interview_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_panelists" ADD CONSTRAINT "interview_panelists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "interview_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_evaluator_id_fkey" FOREIGN KEY ("evaluator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
