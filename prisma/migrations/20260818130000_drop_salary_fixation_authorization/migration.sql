-- Salary Fixation no longer collects Prepared By / Approved By signatures —
-- removed from the modal entirely, so these columns are unused.
ALTER TABLE "salary_fixations" DROP COLUMN "prepared_by_name";
ALTER TABLE "salary_fixations" DROP COLUMN "prepared_by_designation";
ALTER TABLE "salary_fixations" DROP COLUMN "approved_by_name";
ALTER TABLE "salary_fixations" DROP COLUMN "approved_by_designation";
