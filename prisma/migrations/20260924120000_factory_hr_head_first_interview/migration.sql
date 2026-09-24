-- Factory HR Head signs off first-interview finalists; bulk CVs carry a source;
-- a delegate's finished first interview stays finished.

-- 1. Where the recruiter found a CV (key from requisition/cv-sources.ts).
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "cv_source" VARCHAR(30);

-- 2. A delegate's job is done once the verdict is in. Stored, because the
--    candidate's stage can move back to Interview for the second round, and
--    the hold used to come back with it — locking the recruiter out of the
--    very round they were meant to run.
ALTER TABLE "interview_delegations" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP(3);

--    Every hand-off whose candidate already has a verdict is finished.
UPDATE "interview_delegations" d
   SET "completed_at" = now()
  FROM "candidates" c
 WHERE c."id" = d."candidate_id"
   AND d."completed_at" IS NULL
   AND d."revoked_at" IS NULL
   AND (c."stage" IN ('FINAL', 'SELECTED', 'REJECTED') OR c."rejected_at" IS NOT NULL);

-- 3. The Factory HR Head's queue.
DO $$ BEGIN
  CREATE TYPE "FirstInterviewApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'RETURNED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "first_interview_approvals" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "status" "FirstInterviewApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submit_note" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,

    CONSTRAINT "first_interview_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "first_interview_approvals_candidate_id_key" ON "first_interview_approvals"("candidate_id");
CREATE INDEX IF NOT EXISTS "first_interview_approvals_status_idx" ON "first_interview_approvals"("status");
CREATE INDEX IF NOT EXISTS "first_interview_approvals_requisition_id_idx" ON "first_interview_approvals"("requisition_id");

ALTER TABLE "first_interview_approvals" ADD CONSTRAINT "first_interview_approvals_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "first_interview_approvals" ADD CONSTRAINT "first_interview_approvals_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "first_interview_approvals" ADD CONSTRAINT "first_interview_approvals_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "first_interview_approvals" ADD CONSTRAINT "first_interview_approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. The role. It must exist before anyone can be assigned it, and the seed
--    is not run on production, so it belongs here (as central_medical_officer
--    did). Unit-scoped: a Factory HR Head signs off their own unit's finalists.
INSERT INTO "roles" ("id", "key", "name", "description", "scope", "is_system", "created_at", "updated_at")
VALUES (
  gen_random_uuid()::text,
  'factory_hr_head',
  'Factory HR Head',
  'Approves the finalists Factory HR puts through after a first interview, singly or in bulk, before they go to the Corporate Recruiter for the second interview. May return or reject.',
  'UNIT',
  true,
  now(),
  now()
)
ON CONFLICT ("key") DO UPDATE
  SET "is_system" = true,
      "updated_at" = now();
