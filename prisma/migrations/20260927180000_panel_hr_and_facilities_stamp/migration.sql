-- Interviewers sit on a panel "from HR" or from another department, per round.
ALTER TABLE "interview_panelists" ADD COLUMN IF NOT EXISTS "from_hr" BOOLEAN NOT NULL DEFAULT false;

-- The facilities fields are shared by every HR interviewer: stamp each save.
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "package_updated_at" TIMESTAMP(3);
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "package_updated_by_id" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "package_updated_by_name" VARCHAR(150);
