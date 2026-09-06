-- Protect the roles the requisition workflow depends on.
--
-- `corporate_recruiter` was created by hand in Access Control, so it never got
-- the `is_system` flag the seeded roles carry — leaving a delete button on it.
-- Deleting it would break recruiter assignment (`assignRecruiter` and
-- `listRecruiters` resolve holders of that key) and drop its assignments.
--
-- Idempotent: a no-op where the flag is already set.
UPDATE "roles"
SET "is_system" = true, "updated_at" = NOW()
WHERE "key" IN (
  'super_user', 'chro', 'corporate_hr', 'corporate_recruiter',
  'medical_officer', 'requisition_raiser', 'unit_approver', 'sbu_head'
) AND "is_system" = false;
