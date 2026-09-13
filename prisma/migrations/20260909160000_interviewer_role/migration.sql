-- The role a delegated interviewer needs to sign in.
--
-- Sending shortlisted CVs to someone did not grant them anything, and a user
-- with zero role assignments cannot sign in at all (auth.service.ts). So HR
-- could hand candidates to a factory colleague, that person would be notified,
-- and then be told "Your account is not enabled for sign-in" — the work was
-- invisible to the only person who could do it.
--
-- Approval Paths already solves this by provisioning on nomination; this gives
-- delegation the same treatment. Deliberately its own role rather than reusing
-- unit_approver: an interviewer should not become eligible to be named on
-- approval chains as a side effect of being asked to run an interview.
INSERT INTO "roles" ("id", "key", "name", "description", "scope", "is_system", "created_at", "updated_at")
SELECT
  'role_interviewer_seed',
  'interviewer',
  'Interviewer',
  'Runs first interviews for candidates delegated to them. Grants sign-in and access to those candidates only.',
  'UNIT',
  true,
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'interviewer');
