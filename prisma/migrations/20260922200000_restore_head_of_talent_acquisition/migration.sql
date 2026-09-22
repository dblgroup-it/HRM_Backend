-- Put "Head of Talent Acquisition" back on the corporate_hr role.
--
-- 20260911140000_rename_corporate_hr_role renamed it, but prisma/seed.ts still
-- carried the old name, and the seed's upsert rewrites every system role's name
-- on each run. A re-seed on 2026-09-15 therefore reverted it to "Corporate HR"
-- in any database it touched. The seed is fixed alongside this migration; this
-- repairs databases that were already re-seeded, and does nothing to one that
-- was not.
--
-- Display text only: the key stays `corporate_hr`, as do the ApprovalRole and
-- BoardApprovalStage enum values the code is keyed on.
UPDATE "roles"
SET "name"        = 'Head of Talent Acquisition',
    "description" = 'Head of Talent Acquisition — final approver on every requisition chain.',
    "updated_at"  = NOW()
WHERE "key" = 'corporate_hr'
  AND "name" <> 'Head of Talent Acquisition';

UPDATE "roles"
SET "description" = 'Runs a requisition’s hiring lifecycle once Head of Talent Acquisition assigns it to them.',
    "updated_at"  = NOW()
WHERE "key" = 'corporate_recruiter'
  AND "description" LIKE '%Corporate HR%';
