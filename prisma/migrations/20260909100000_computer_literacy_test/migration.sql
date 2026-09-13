-- Computer Literacy: a third pre-interview screening test, marked by hand the
-- same way the Written Test is. Mirrors the written_test_* trio exactly so the
-- evaluation and banding logic treats all three alike.
ALTER TABLE "salary_fixations"
  ADD COLUMN IF NOT EXISTS "computer_test_enabled"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "computer_test_total"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "computer_test_obtained" DOUBLE PRECISION;
