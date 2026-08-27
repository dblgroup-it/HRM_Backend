-- AlterTable
ALTER TABLE "ai_proficiency_attempts" ADD COLUMN     "started_at" TIMESTAMP(3),
ADD COLUMN     "time_limit_minutes" INTEGER;
