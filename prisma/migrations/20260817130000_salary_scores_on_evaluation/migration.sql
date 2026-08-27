-- AlterTable: panelists mark salary-fixation criteria as part of their own evaluation
ALTER TABLE "evaluations" ADD COLUMN "salary_scores" JSONB, ADD COLUMN "salary_total" DOUBLE PRECISION;

-- AlterTable: committee scores now live on evaluations, not a JSON blob on salary_fixations
ALTER TABLE "salary_fixations" DROP COLUMN "interviewer_count", DROP COLUMN "interviewers";
