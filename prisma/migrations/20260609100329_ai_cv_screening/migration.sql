-- AlterEnum
ALTER TYPE "CandidateStage" ADD VALUE 'AI_SHORTLISTED';

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "match_score" INTEGER,
ADD COLUMN     "match_summary" TEXT,
ADD COLUMN     "screened_at" TIMESTAMP(3);
