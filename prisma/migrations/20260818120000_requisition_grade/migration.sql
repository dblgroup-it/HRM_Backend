-- Confirmed job grade on the requisition itself (distinct from the organogram
-- seat's grade / the ZingHR grade reference, both of which are just inputs
-- the current approver considers when confirming this value).
ALTER TABLE "requisitions" ADD COLUMN "grade" VARCHAR(20);

-- New activity-log action for non-approval edits (e.g. confirming/changing
-- the requisition's grade) so they show up in the existing Activity history.
ALTER TYPE "ApprovalDecision" ADD VALUE IF NOT EXISTS 'EDITED';
