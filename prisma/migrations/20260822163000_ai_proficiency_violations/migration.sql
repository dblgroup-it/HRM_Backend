-- AlterTable
ALTER TABLE "ai_proficiency_attempts" ADD COLUMN     "termination_reason" VARCHAR(20),
ADD COLUMN     "violations" JSONB;
