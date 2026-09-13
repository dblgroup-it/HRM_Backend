-- Corporate HR is now called Head of Talent Acquisition.
--
-- Display name only. The role's key stays `corporate_hr`, and so do the
-- ApprovalRole.CORPORATE_HR and BoardApprovalStage.corporate_hr enum values:
-- those are identifiers the code and existing rows are keyed on, including
-- approval chains already snapshotted onto in-flight requisitions. Renaming
-- them would rewrite history and buy nothing a user can see.
--
-- Note the department called "Corporate HR" is a different thing entirely and
-- is deliberately left alone.
UPDATE "roles"
SET "name" = 'Head of Talent Acquisition',
    "description" = 'Head of Talent Acquisition — final approver on every requisition chain.',
    "updated_at" = NOW()
WHERE "key" = 'corporate_hr';
