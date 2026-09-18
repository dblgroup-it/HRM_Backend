-- DBL's pre-employment reference check: one row per referee, filled in by the
-- recruiter who made the call.
CREATE TABLE IF NOT EXISTS "reference_checks" (
  "id" TEXT NOT NULL,
  "candidate_id" TEXT NOT NULL,
  "referee_name" VARCHAR(150) NOT NULL,
  "referee_designation" VARCHAR(150),
  "referee_organization" VARCHAR(200),
  "referee_email" VARCHAR(254),
  "referee_phone" VARCHAR(40),
  "known_duration" TEXT,
  "relationship" TEXT,
  "strengths" TEXT,
  "weaknesses" TEXT,
  "ratings" JSONB NOT NULL DEFAULT '{}',
  "handover" TEXT,
  "rehire_eligible" TEXT,
  "concerns" TEXT,
  "overall_comments" TEXT,
  "conducted_by_id" TEXT NOT NULL,
  "conducted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "file_id" TEXT,
  "url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reference_checks_pkey" PRIMARY KEY ("id")
);

-- Foreign keys are not indexed automatically; this one is read per candidate.
CREATE INDEX IF NOT EXISTS "reference_checks_candidate_id_idx"
  ON "reference_checks"("candidate_id");

ALTER TABLE "reference_checks"
  DROP CONSTRAINT IF EXISTS "reference_checks_candidate_id_fkey";
ALTER TABLE "reference_checks"
  ADD CONSTRAINT "reference_checks_candidate_id_fkey"
  FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict: a completed reference check records who conducted it, and that
-- attribution must not disappear if the user row is removed.
ALTER TABLE "reference_checks"
  DROP CONSTRAINT IF EXISTS "reference_checks_conducted_by_id_fkey";
ALTER TABLE "reference_checks"
  ADD CONSTRAINT "reference_checks_conducted_by_id_fkey"
  FOREIGN KEY ("conducted_by_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
