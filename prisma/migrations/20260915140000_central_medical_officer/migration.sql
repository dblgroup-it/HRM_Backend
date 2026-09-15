-- A second pair of eyes on every medical finding.
--
-- Until now the examining officer's decision WAS the clearance. A Central
-- Medical Officer now confirms it: the officer records the finding as before,
-- it waits in `submitted`, and only a central sign-off moves it to `cleared`
-- or `rejected`.
--
-- `submitted` is deliberately not a cleared state. Every downstream gate reads
-- `medicalStatus = 'cleared'`, so a candidate waiting on the CMO cannot reach
-- the appointment letter — which is the whole point of adding the layer.
--
-- Additive. Existing rows keep their status and their `medical_cleared_by_id`;
-- nothing already cleared is reopened.

-- ── 1. The waiting state ────────────────────────────────────────────────────
-- Adding an enum value is allowed inside a transaction on PostgreSQL 12+; the
-- new value merely cannot be USED in that same transaction, and nothing here
-- writes it. `IF NOT EXISTS` so re-running is safe.
ALTER TYPE "MedicalStatus" ADD VALUE IF NOT EXISTS 'submitted' AFTER 'pending';

-- ── 2. What was submitted, by whom, and who signed it off ───────────────────
ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "medical_proposed"        "MedicalStatus",
  ADD COLUMN IF NOT EXISTS "medical_submitted_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "medical_submitted_by_id" TEXT,
  ADD COLUMN IF NOT EXISTS "medical_approved_at"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "medical_approved_by_id"  TEXT,
  ADD COLUMN IF NOT EXISTS "medical_cmo_note"        TEXT;

-- Guarded: ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS, and this
-- migration must survive being re-run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'onboardings_medical_submitted_by_id_fkey') THEN
    ALTER TABLE "onboardings"
      ADD CONSTRAINT "onboardings_medical_submitted_by_id_fkey"
      FOREIGN KEY ("medical_submitted_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'onboardings_medical_approved_by_id_fkey') THEN
    ALTER TABLE "onboardings"
      ADD CONSTRAINT "onboardings_medical_approved_by_id_fkey"
      FOREIGN KEY ("medical_approved_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 3. The Central Medical Officer's queue ──────────────────────────────────
-- Composite rather than partial, and that is not a style choice: a partial
-- index `WHERE medical_status = 'submitted'` USES the enum value added at the
-- top of this file, and PostgreSQL refuses to use a new enum value in the same
-- transaction that created it. Prisma runs each migration in a transaction, so
-- the partial form fails on deploy with "unsafe use of new value". Leading on
-- the status column serves the queue query just as well.
CREATE INDEX IF NOT EXISTS "onboardings_medical_status_submitted_idx"
  ON "onboardings" ("medical_status", "medical_submitted_at");

-- Foreign keys are not indexed automatically in PostgreSQL, and these back the
-- "what have I signed off" and "what did I submit" views.
CREATE INDEX IF NOT EXISTS "onboardings_medical_submitted_by_idx"
  ON "onboardings" ("medical_submitted_by_id");
CREATE INDEX IF NOT EXISTS "onboardings_medical_approved_by_idx"
  ON "onboardings" ("medical_approved_by_id");
