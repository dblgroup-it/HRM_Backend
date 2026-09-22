-- Standby cover: who picks up the work when somebody is away.
--
-- Two halves of the same problem. A unit's Factory HR holders are now an
-- ordered queue — HR1 first, HR2 behind them — and a requisition's job analysis
-- is addressed to the first of them who is not on leave. A Corporate Recruiter
-- going on leave instead nominates a stand-in per requisition, because their
-- requisitions are each at a different point and there is no sensible default.
--
-- Leave itself is a dated period, not a flag: it says until when, it keeps the
-- history, and it expires on its own, so nothing has to run at midnight to put
-- anybody back on duty.

-- Standby order within a unit. Null = unordered, which is how every existing
-- assignment starts, and that behaves exactly as it did before.
ALTER TABLE "role_assignments"
  ADD COLUMN IF NOT EXISTS "priority" INTEGER;

CREATE TABLE IF NOT EXISTS "leave_periods" (
    "id"         TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    "starts_at"  TIMESTAMP(3) NOT NULL,
    -- Null = until further notice; ended by hand.
    "ends_at"    TIMESTAMP(3),
    -- Set on "I'm back" before ends_at. Any cover riding on it lapses too.
    "ended_at"   TIMESTAMP(3),
    "note"       TEXT,
    "set_by_id"  TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leave_periods_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "leave_periods_user_id_starts_at_idx"
  ON "leave_periods"("user_id", "starts_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'leave_periods_user_id_fkey') THEN
    ALTER TABLE "leave_periods" ADD CONSTRAINT "leave_periods_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'leave_periods_set_by_id_fkey') THEN
    ALTER TABLE "leave_periods" ADD CONSTRAINT "leave_periods_set_by_id_fkey"
      FOREIGN KEY ("set_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Who the job analysis is addressed to, and who is covering the recruiter.
-- `cover_until` repeats the leave's end date on the requisition on purpose: the
-- recruitment gate is checked on nearly every candidate, interview and
-- onboarding call, and this way it stays an id comparison and a date, with no
-- join and nothing scheduled to run for a cover to expire on time.
ALTER TABLE "requisitions"
  ADD COLUMN IF NOT EXISTS "job_analysis_assignee_id" TEXT,
  ADD COLUMN IF NOT EXISTS "cover_recruiter_id"       TEXT,
  ADD COLUMN IF NOT EXISTS "cover_leave_id"           TEXT,
  ADD COLUMN IF NOT EXISTS "cover_until"              TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'requisitions_job_analysis_assignee_id_fkey') THEN
    ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_job_analysis_assignee_id_fkey"
      FOREIGN KEY ("job_analysis_assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'requisitions_cover_recruiter_id_fkey') THEN
    ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_cover_recruiter_id_fkey"
      FOREIGN KEY ("cover_recruiter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'requisitions_cover_leave_id_fkey') THEN
    ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_cover_leave_id_fkey"
      FOREIGN KEY ("cover_leave_id") REFERENCES "leave_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "requisitions_job_analysis_assignee_id_idx"
  ON "requisitions"("job_analysis_assignee_id");
CREATE INDEX IF NOT EXISTS "requisitions_cover_recruiter_id_idx"
  ON "requisitions"("cover_recruiter_id");

-- Requisitions already waiting on a job analysis were addressed to "whoever
-- holds Factory HR for the unit". Leaving the assignee null keeps them exactly
-- that, rather than picking a person retrospectively.
