-- Ensure the corporate_recruiter role EXISTS.
--
-- The earlier 20260906_protect_corporate_recruiter_role migration only flipped
-- `is_system` on rows that were already there. That was written against a dev
-- database where the role had been created by hand in Access Control — on any
-- environment that never had it (production included) it is a no-op, leaving
-- the recruiter handoff broken: requisition.service resolves candidates via
-- roleHolders('corporate_recruiter', …), so GET /requisitions/:id/recruiters
-- returns an empty list and no recruiter can be assigned.
--
-- Roles are otherwise only created by prisma/seed.ts, which must never run
-- against production (it also upserts the admin user, units, departments,
-- positions and sample employees). So the role is created here instead.
--
-- Idempotent: inserts when missing, and only re-asserts the protection flag
-- when present. Existing name/description are left alone.
INSERT INTO "roles" ("id", "key", "name", "description", "scope", "is_system", "created_at", "updated_at")
VALUES (
  gen_random_uuid()::text,
  'corporate_recruiter',
  'Corporate Recruiter',
  'Runs a requisition''s hiring lifecycle once Corporate HR assigns it to them.',
  'GLOBAL',
  true,
  NOW(),
  NOW()
)
ON CONFLICT ("key") DO UPDATE SET "is_system" = true;
