-- CreateEnum
CREATE TYPE "CandidateStage" AS ENUM ('APPLIED', 'SHORTLISTED', 'INTERVIEW', 'FINAL', 'SELECTED', 'REJECTED');

-- AlterTable
ALTER TABLE "requisitions" ADD COLUMN     "drive" JSONB;

-- AlterTable
ALTER TABLE "sync_logs" ALTER COLUMN "logs" DROP DEFAULT;

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "stage" "CandidateStage" NOT NULL DEFAULT 'APPLIED',
    "cv_file_id" TEXT,
    "cv_url" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "candidates_requisition_id_stage_idx" ON "candidates"("requisition_id", "stage");

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
