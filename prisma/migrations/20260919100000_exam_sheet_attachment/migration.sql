-- The marked answer script for a hand-marked screening test, scanned and
-- attached. Optional: a test can be marked without one, as it always could.
ALTER TABLE "salary_fixations"
  ADD COLUMN IF NOT EXISTS "written_test_sheet_id" TEXT,
  ADD COLUMN IF NOT EXISTS "written_test_sheet_url" TEXT,
  ADD COLUMN IF NOT EXISTS "computer_test_sheet_id" TEXT,
  ADD COLUMN IF NOT EXISTS "computer_test_sheet_url" TEXT;
