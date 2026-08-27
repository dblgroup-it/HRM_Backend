-- DropForeignKey
ALTER TABLE "rubric_criteria" DROP CONSTRAINT "rubric_criteria_requisition_id_fkey";

-- AlterTable: interview scoring collapses into the fixed 10-criteria set used
-- by both the hiring scorecard and salary fixation — no more separate salary fields.
ALTER TABLE "evaluations" DROP COLUMN "salary_scores",
DROP COLUMN "salary_total";

-- DropTable: no more HR-configurable rubric, every interview scores the same fixed criteria.
DROP TABLE "rubric_criteria";
