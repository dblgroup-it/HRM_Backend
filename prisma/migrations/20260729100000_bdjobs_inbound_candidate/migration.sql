-- Add bdjobs as a candidate source (inbound from Bdjobs job portal)
ALTER TYPE "CandidateSource" ADD VALUE IF NOT EXISTS 'bdjobs';

-- Bdjobs inbound tracking columns on candidates
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS bdjobs_application_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bdjobs_applicant_id   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bdjobs_job_id         VARCHAR(100);

-- Unique constraint used for deduplication: one record per Bdjobs application
CREATE UNIQUE INDEX IF NOT EXISTS "candidates_bdjobs_application_id_key"
  ON candidates (bdjobs_application_id)
  WHERE bdjobs_application_id IS NOT NULL;
