-- Delegating a shortlisted candidate's first interview to factory / unit staff.
--
-- Until now only Corporate HR, CHRO, super users and the assigned recruiter
-- could schedule a round or form a committee. This lets the recruiter hand a
-- specific set of shortlisted candidates to named people, who then run the
-- first session themselves — but only for the candidates handed to them.
--
-- One row per (candidate, delegate): several people can share a candidate, and
-- one person can hold many candidates.

CREATE TABLE IF NOT EXISTS "interview_delegations" (
  "id"             TEXT NOT NULL,
  "candidate_id"   TEXT NOT NULL,
  "requisition_id" TEXT NOT NULL,
  "delegated_to_id" TEXT NOT NULL,
  "delegated_by_id" TEXT,
  "note"           TEXT,
  "revoked_at"     TIMESTAMP(3),
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "interview_delegations_pkey" PRIMARY KEY ("id")
);

-- A person is delegated a candidate once; re-sending updates rather than piles up.
CREATE UNIQUE INDEX IF NOT EXISTS "interview_delegations_candidate_delegate_key"
  ON "interview_delegations" ("candidate_id", "delegated_to_id");

CREATE INDEX IF NOT EXISTS "interview_delegations_delegate_idx"
  ON "interview_delegations" ("delegated_to_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "interview_delegations_requisition_idx"
  ON "interview_delegations" ("requisition_id");

ALTER TABLE "interview_delegations"
  ADD CONSTRAINT "interview_delegations_candidate_id_fkey"
  FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interview_delegations"
  ADD CONSTRAINT "interview_delegations_requisition_id_fkey"
  FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interview_delegations"
  ADD CONSTRAINT "interview_delegations_delegated_to_id_fkey"
  FOREIGN KEY ("delegated_to_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interview_delegations"
  ADD CONSTRAINT "interview_delegations_delegated_by_id_fkey"
  FOREIGN KEY ("delegated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
