-- Two things a requisition could not express before.
--
-- 1. A post offered at more than one level. "Senior Executive or Assistant
--    Manager" is a real vacancy: the level depends on who is found. Until now
--    that was typed into the single designation field as "Senior Exe/Asst
--    Manager", which reads badly on an approval sheet and cannot be resolved
--    into a real designation for the offer letter.
--
-- 2. A requisition replacing more than one person. Three operators leave in the
--    same month and one requisition refills the line; only the first name could
--    be recorded, so the other two vanished from the approval sheet.
--
-- Entirely additive. Every existing column keeps its meaning, so a requisition
-- raised before this migration reads and behaves exactly as it did.

-- ── 1. Alternate designations ───────────────────────────────────────────────
-- `designation` stays the primary one. The organogram lookup, approval routing
-- and every report read it, and an empty array here is indistinguishable from
-- the old single-designation behaviour.
ALTER TABLE "requisitions"
  ADD COLUMN IF NOT EXISTS "alternate_designations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── 2. The people a requisition replaces ────────────────────────────────────
-- Names are snapshots, not foreign keys: the person has usually already left,
-- and a requisition must still read correctly after their record is archived.
CREATE TABLE IF NOT EXISTS "requisition_replacements" (
  "id"                TEXT         NOT NULL,
  "requisition_id"    TEXT         NOT NULL,
  "employee_name"     VARCHAR(150) NOT NULL,
  "employee_code"     VARCHAR(50),
  "separation_reason" VARCHAR(120),
  "vacant_date"       DATE,
  "remarks"           TEXT,
  "order_index"       INTEGER      NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "requisition_replacements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "requisition_replacements_requisition_id_idx"
  ON "requisition_replacements" ("requisition_id");

-- Guarded: re-running the migration on a database that already has it must not
-- fail, and ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'requisition_replacements_requisition_id_fkey'
  ) THEN
    ALTER TABLE "requisition_replacements"
      ADD CONSTRAINT "requisition_replacements_requisition_id_fkey"
      FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 3. Carry existing replacements into the new table ───────────────────────
-- Without this, every requisition already raised as a Replacement would show an
-- empty list the moment the UI starts reading `replacements`. The old columns
-- are NOT dropped: the approval sheet, the board export and several reports
-- read them directly, and the application keeps them in step with the first
-- entry. `separation_reason` is TEXT on requisitions and VARCHAR(120) here, so
-- it is truncated rather than allowed to fail the migration.
INSERT INTO "requisition_replacements" (
  "id", "requisition_id", "employee_name", "employee_code",
  "separation_reason", "vacant_date", "remarks", "order_index", "created_at"
)
SELECT
  gen_random_uuid()::text,
  r."id",
  btrim(r."replace_of_name"),
  NULLIF(btrim(COALESCE(r."replace_of_employee_code", '')), ''),
  LEFT(NULLIF(btrim(COALESCE(r."separation_reason", '')), ''), 120),
  r."vacant_date",
  NULLIF(btrim(COALESCE(r."replacement_remarks", '')), ''),
  0,
  COALESCE(r."created_at", now())
FROM "requisitions" r
WHERE r."replace_of_name" IS NOT NULL
  AND btrim(r."replace_of_name") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "requisition_replacements" x WHERE x."requisition_id" = r."id"
  );

-- ── 4. The designation a candidate is actually hired at ─────────────────────
-- Set during onboarding, before the offer letter is generated. NULL means the
-- requisition's primary designation — which is every candidate hired so far.
ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "fixed_designation" VARCHAR(150);
