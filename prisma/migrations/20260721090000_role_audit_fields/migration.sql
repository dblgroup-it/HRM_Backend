-- Add created_by_id and updated_by_id audit fields to roles.

ALTER TABLE "roles"
  ADD COLUMN "created_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN "updated_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL;
