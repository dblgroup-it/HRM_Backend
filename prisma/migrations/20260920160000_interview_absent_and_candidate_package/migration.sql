-- Two additions, both additive.
--
-- 1. A candidate who does not turn up is not the same event as the company
--    cancelling the interview. The panel's time was spent either way, and HR
--    reads the two very differently, so ABSENT is its own status.
-- 2. What the candidate earns now and what they are asking for, taken in the
--    interview room. They are facts about the person, not about one round,
--    so they sit on the candidate.

ALTER TYPE "InterviewStatus" ADD VALUE IF NOT EXISTS 'ABSENT';

ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "present_salary" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "salary_benefits_note" TEXT;
