-- Factory HR is back, and the Job Analysis is its job.
--
-- The requisitioner now fills only section A (Vacancy Information) and the
-- facility requirements. The requisition then waits on the unit's Factory HR,
-- who writes the job description / specification and attaches the detailed JD,
-- and only then does the configured approval path start. A unit with no Factory
-- HR of its own falls back to Corporate HR / a Corporate Recruiter.
--
-- Factory HR is deliberately NOT an approval level: chains stay a list of named
-- people configured in Approval Paths (see 20260903160000_paths_per_raiser_drop_factory_hr).

-- The stage between "raised" and "in the chain".
ALTER TYPE "RequisitionStatus" ADD VALUE IF NOT EXISTS 'PENDING_JOB_ANALYSIS' BEFORE 'PENDING_APPROVAL';

-- Who completed the job analysis, and when. Recorded because requisition
-- visibility is "your own business only" — without it the Factory HR who wrote
-- the job description would lose sight of the requisition as soon as it moved
-- into the chain. The return columns hold Factory HR's bounce back to the
-- raiser (the vacancy details are the raiser's to fix), cleared on resend.
ALTER TABLE "requisitions"
  ADD COLUMN IF NOT EXISTS "job_analysis_by_id"       TEXT,
  ADD COLUMN IF NOT EXISTS "job_analysis_at"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "job_analysis_returned_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "job_analysis_return_note" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'requisitions_job_analysis_by_id_fkey'
  ) THEN
    ALTER TABLE "requisitions"
      ADD CONSTRAINT "requisitions_job_analysis_by_id_fkey"
      FOREIGN KEY ("job_analysis_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "requisitions_job_analysis_by_id_idx"
  ON "requisitions"("job_analysis_by_id");

-- The role itself, unit-scoped as it was before it was retired. Assignments are
-- made per unit in Configuration -> Access Control; the holders removed on
-- 2026-09-03 are listed in HRM_Backend/backups/factory_hr_assignments_removed_20260903.txt
-- and are NOT restored automatically.
INSERT INTO "roles" ("id", "key", "name", "description", "scope", "is_system", "created_at", "updated_at")
VALUES (
  'role_factory_hr',
  'factory_hr',
  'Factory HR',
  'Unit / factory HR. Completes the Job Analysis and attachments on their unit''s requisitions before the approval chain starts.',
  'UNIT',
  true,
  NOW(),
  NOW()
)
ON CONFLICT ("key") DO UPDATE
  SET "name"        = EXCLUDED."name",
      "description" = EXCLUDED."description",
      "scope"       = EXCLUDED."scope",
      "is_system"   = true,
      "updated_at"  = NOW();
