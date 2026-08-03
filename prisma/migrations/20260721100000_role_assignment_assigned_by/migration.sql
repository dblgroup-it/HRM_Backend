-- Track who assigned a role (no updated_by — assignments are create/delete only).

ALTER TABLE "role_assignments"
  ADD COLUMN "assigned_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL;
