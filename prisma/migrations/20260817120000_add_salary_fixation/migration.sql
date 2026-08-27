-- CreateEnum
CREATE TYPE "SalaryFixationStatus" AS ENUM ('draft', 'screening_failed', 'fixed');

-- CreateTable
CREATE TABLE "salary_fixations" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "job_grade" VARCHAR(10),
    "written_test_enabled" BOOLEAN NOT NULL DEFAULT false,
    "written_test_total" DOUBLE PRECISION,
    "written_test_obtained" DOUBLE PRECISION,
    "ai_test_total" DOUBLE PRECISION,
    "ai_test_obtained" DOUBLE PRECISION,
    "interviewer_count" INTEGER NOT NULL DEFAULT 3,
    "interviewers" JSONB NOT NULL DEFAULT '[]',
    "average_score" DOUBLE PRECISION,
    "computed_band" INTEGER,
    "band_override" INTEGER,
    "proposed_salary" DOUBLE PRECISION,
    "status" "SalaryFixationStatus" NOT NULL DEFAULT 'draft',
    "prepared_by_name" VARCHAR(150),
    "prepared_by_designation" VARCHAR(150),
    "approved_by_name" VARCHAR(150),
    "approved_by_designation" VARCHAR(150),
    "finalized_at" TIMESTAMP(3),
    "finalized_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_fixations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salary_fixations_candidate_id_key" ON "salary_fixations"("candidate_id");

-- AddForeignKey
ALTER TABLE "salary_fixations" ADD CONSTRAINT "salary_fixations_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
