-- AlterTable
ALTER TABLE "requisitions" ADD COLUMN "interview_questions" JSONB;

-- AlterTable
ALTER TABLE "interview_rounds" ADD COLUMN "questions_sent_at" TIMESTAMP(3);
