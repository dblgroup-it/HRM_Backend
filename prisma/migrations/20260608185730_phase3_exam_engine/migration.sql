-- CreateEnum
CREATE TYPE "ExamQuestionKind" AS ENUM ('MCQ', 'TEXT');

-- CreateTable
CREATE TABLE "exam_questions" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "exam_type" "AssessmentType" NOT NULL,
    "kind" "ExamQuestionKind" NOT NULL DEFAULT 'MCQ',
    "prompt" TEXT NOT NULL,
    "options" JSONB,
    "answer" TEXT,
    "marks" INTEGER NOT NULL DEFAULT 1,
    "order_index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "exam_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_attempts" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "exam_type" "AssessmentType" NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answers" JSONB,
    "grades" JSONB,
    "auto_score" INTEGER,
    "total_score" INTEGER,
    "max_score" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "graded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_questions_requisition_id_exam_type_idx" ON "exam_questions"("requisition_id", "exam_type");

-- CreateIndex
CREATE UNIQUE INDEX "exam_attempts_token_key" ON "exam_attempts"("token");

-- CreateIndex
CREATE INDEX "exam_attempts_candidate_id_idx" ON "exam_attempts"("candidate_id");

-- CreateIndex
CREATE INDEX "exam_attempts_requisition_id_idx" ON "exam_attempts"("requisition_id");

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
