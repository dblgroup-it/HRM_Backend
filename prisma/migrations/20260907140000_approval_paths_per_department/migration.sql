-- Approval paths become configurable per department within a unit.
--
-- `department` uses '' to mean "any department in this unit" — the same
-- empty-string-as-wildcard convention master_options.parent already uses, and
-- it keeps the unique key working (Postgres treats NULLs as distinct, so a
-- nullable column would happily allow two unit-wide rows for one raiser).
--
-- Resolution at raise time is exact department first, then the '' default.
-- Every existing path becomes that unit-wide default, so nothing stops routing
-- the moment this deploys.

ALTER TABLE "approval_paths"
  ADD COLUMN IF NOT EXISTS "department" VARCHAR(150) NOT NULL DEFAULT '';

-- One chain per (unit, raiser, department) instead of per (unit, raiser).
ALTER TABLE "approval_paths"
  DROP CONSTRAINT IF EXISTS "approval_paths_unit_id_raiser_id_key";
DROP INDEX IF EXISTS "approval_paths_unit_id_raiser_id_key";

CREATE UNIQUE INDEX IF NOT EXISTS "approval_paths_unit_id_raiser_id_department_key"
  ON "approval_paths" ("unit_id", "raiser_id", "department");

CREATE INDEX IF NOT EXISTS "approval_paths_unit_id_department_idx"
  ON "approval_paths" ("unit_id", "department");
