-- 23.1 CandidateSource enum for the source field.
CREATE TYPE "CandidateSource" AS ENUM ('drive', 'email', 'upload', 'manual', 'application');

ALTER TABLE "candidates" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "candidates" ALTER COLUMN "source" TYPE "CandidateSource" USING "source"::"CandidateSource";
ALTER TABLE "candidates" ALTER COLUMN "source" SET DEFAULT 'manual'::"CandidateSource";

-- 23.3 match_score → DOUBLE PRECISION for decimal AI scores.
-- INTEGER → DOUBLE PRECISION is an implicit cast; no USING clause needed.
ALTER TABLE "candidates" ALTER COLUMN "match_score" TYPE DOUBLE PRECISION;

-- 23.4 salary_expectation VARCHAR → DOUBLE PRECISION.
-- NULLIF trims and converts empty strings to NULL before casting.
ALTER TABLE "candidates"
  ALTER COLUMN "salary_expectation" TYPE DOUBLE PRECISION
  USING NULLIF(TRIM("salary_expectation"), '')::DOUBLE PRECISION;

-- 23.5 created_by_id: tracks who manually added the candidate.
ALTER TABLE "candidates"
  ADD COLUMN "created_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL;
