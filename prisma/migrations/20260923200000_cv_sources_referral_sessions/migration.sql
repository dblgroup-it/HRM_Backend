-- 1. CV collection sources, ticked by Head of Talent Acquisition before a
--    recruiter is assigned.
ALTER TABLE "requisitions"
  ADD COLUMN IF NOT EXISTS "cv_sources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "cv_sources_set_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cv_sources_set_by" VARCHAR(150);

-- 2. Employee referral on a candidate — a snapshot of the referrer.
ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "referred_by_code" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "referred_by_name" VARCHAR(150),
  ADD COLUMN IF NOT EXISTS "referred_by_designation" VARCHAR(150);

-- 3. A job analysis is no longer addressed to one Factory HR: every holder
--    on duty gets it and any of them may continue it. Release the ones still
--    waiting so they reach the whole unit, not only the person they were
--    addressed to.
UPDATE "requisitions"
   SET "job_analysis_assignee_id" = NULL
 WHERE "status" = 'PENDING_JOB_ANALYSIS'
   AND "job_analysis_assignee_id" IS NOT NULL;

-- 4. Signing out revokes one session, not every session the account holds.
CREATE TABLE IF NOT EXISTS "revoked_sessions" (
  "jti" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("jti")
);
CREATE INDEX IF NOT EXISTS "revoked_sessions_expires_at_idx" ON "revoked_sessions"("expires_at");
