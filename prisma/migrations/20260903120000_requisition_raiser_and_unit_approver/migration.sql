-- Role catalogue changes that follow from configurable approval paths.
--
-- 1. `department_head` becomes `requisition_raiser`. Since chains are now an
--    ordered list of named approvers, that role is no longer an approval step
--    at all — its only job is "may open a requisition for this unit", so the
--    name now says that. Renamed in place: role_assignments reference roles.id,
--    not the key, so every existing holder keeps their access untouched.
--
-- 2. New `unit_approver` role. Approval levels name a *person*, and a person
--    with zero role assignments cannot sign in (auth.service.ts), so they could
--    never action their step. This gives Corporate HR something to grant an
--    approver who holds no other function: it enables sign-in and unit access
--    for that unit, and nothing else.
--
-- Both statements are idempotent — safe on a fresh database (no-ops) and on an
-- existing one.

UPDATE "roles"
SET "key"         = 'requisition_raiser',
    "name"        = 'Requisition Raiser',
    "description" = 'Opens requisitions for their unit. Not an approval step — the sign-off chain is configured per unit in Approval Paths.',
    "updated_at"  = NOW()
WHERE "key" = 'department_head';

INSERT INTO "roles" ("id", "key", "name", "description", "scope", "is_system", "created_at", "updated_at")
VALUES (
  gen_random_uuid()::text,
  'unit_approver',
  'Unit Approver',
  'Can be named as an approval level for their unit. Grants sign-in and visibility of that unit''s requisitions — nothing else.',
  'UNIT',
  true,
  NOW(),
  NOW()
)
ON CONFLICT ("key") DO NOTHING;
