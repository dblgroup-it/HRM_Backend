-- Create the Central Medical Officer role.
--
-- The role has to EXIST before anyone can be assigned it in Access Control, and
-- the medical approval layer is unusable until someone is. prisma/seed.ts also
-- defines it, but the seed is a development tool: it upserts an admin login,
-- sample units, positions and employees, so it is not something to run against
-- production. deploy.sh deliberately does not call it.
--
-- A role the workflow depends on therefore belongs in a migration, which is the
-- only thing that runs on every environment.
--
-- `is_system = true` so it cannot be deleted from Access Control while the
-- approval step depends on it, matching how the other workflow roles are
-- seeded. Idempotent: re-running changes nothing, and it will not fight the
-- seed on a machine where both run.
INSERT INTO "roles" ("id", "key", "name", "description", "scope", "is_system", "created_at", "updated_at")
VALUES (
  gen_random_uuid()::text,
  'central_medical_officer',
  'Central Medical Officer',
  'Confirms every medical finding before a candidate is cleared. Approves singly or in bulk; may overturn or return a submission.',
  'GLOBAL',
  true,
  now(),
  now()
)
ON CONFLICT ("key") DO UPDATE
  -- Only the flag is forced. A name or description edited in Access Control is
  -- somebody's deliberate wording and is left alone; `is_system` is not
  -- cosmetic, it is what stops the role being deleted out from under the
  -- workflow.
  SET "is_system" = true,
      "updated_at" = now();
