-- "DBL Group — Head Office" is now "DBL Group — Corporate Office".
--
-- Units are matched by NAME across the app (a requisition stores its unit as
-- text, the organogram lookup and role routing compare names), so renaming the
-- unit row alone would orphan every requisition raised under it. Everything
-- that holds the name as a value moves with it. Notifications and the audit
-- log are left as they were written — they are history.
-- Skipped entirely if a unit with the new name already exists (the unique
-- name would collide); that case needs a merge, not a rename.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "units" WHERE "name" = 'DBL Group — Corporate Office') THEN
    RAISE NOTICE 'A unit named DBL Group — Corporate Office already exists; rename skipped';
    RETURN;
  END IF;

  UPDATE "units"         SET "name" = 'DBL Group — Corporate Office' WHERE "name" = 'DBL Group — Head Office';
  UPDATE "requisitions"  SET "unit_factory" = 'DBL Group — Corporate Office' WHERE "unit_factory" = 'DBL Group — Head Office';
  UPDATE "employees"     SET "unit_name" = 'DBL Group — Corporate Office' WHERE "unit_name" = 'DBL Group — Head Office';
  UPDATE "master_options" SET "value" = 'DBL Group — Corporate Office' WHERE "value" = 'DBL Group — Head Office';
  UPDATE "master_options" SET "parent" = 'DBL Group — Corporate Office' WHERE "parent" = 'DBL Group — Head Office';
END $$;
