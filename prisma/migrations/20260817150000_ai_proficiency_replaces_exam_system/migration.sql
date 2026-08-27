-- DropForeignKey
ALTER TABLE "assessment_components" DROP CONSTRAINT "assessment_components_requisition_id_fkey";

-- DropForeignKey
ALTER TABLE "exam_attempts" DROP CONSTRAINT "exam_attempts_candidate_id_fkey";

-- DropForeignKey
ALTER TABLE "exam_attempts" DROP CONSTRAINT "exam_attempts_requisition_id_fkey";

-- DropForeignKey
ALTER TABLE "exam_questions" DROP CONSTRAINT "exam_questions_requisition_id_fkey";

-- DropTable: old per-requisition "Assessment Plan" toggle (Written/Excel/Skill/Viva) — retired.
DROP TABLE "assessment_components";

-- DropTable: old per-requisition online exam system — replaced by a global AI Proficiency bank.
DROP TABLE "exam_attempts";

-- DropTable
DROP TABLE "exam_questions";

-- DropEnum
DROP TYPE "AssessmentType";

-- DropEnum
DROP TYPE "ExamQuestionKind";

-- CreateTable
CREATE TABLE "ai_proficiency_questions" (
    "id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "answer" TEXT NOT NULL,
    "marks" INTEGER NOT NULL DEFAULT 1,
    "grades" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_proficiency_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_proficiency_attempts" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "job_grade" VARCHAR(10) NOT NULL,
    "question_ids" TEXT[],
    "answers" JSONB,
    "total_score" DOUBLE PRECISION,
    "max_score" DOUBLE PRECISION NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_proficiency_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_proficiency_questions_grades_idx" ON "ai_proficiency_questions"("grades");

-- CreateIndex
CREATE UNIQUE INDEX "ai_proficiency_attempts_candidate_id_key" ON "ai_proficiency_attempts"("candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_proficiency_attempts_token_key" ON "ai_proficiency_attempts"("token");

-- AddForeignKey
ALTER TABLE "ai_proficiency_attempts" ADD CONSTRAINT "ai_proficiency_attempts_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
