-- Add created_by_id and updated_by_id audit fields to units, departments, positions.

ALTER TABLE "units"
  ADD COLUMN "created_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN "updated_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "departments"
  ADD COLUMN "created_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN "updated_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "positions"
  ADD COLUMN "created_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN "updated_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL;
