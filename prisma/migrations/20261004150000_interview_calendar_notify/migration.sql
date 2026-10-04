-- "Notify on calendar" per interview round, and whether the candidate is on
-- the invite. Existing rounds keep the behaviour they were made with: everyone
-- invited, the candidate included on any later change.
ALTER TABLE "interview_rounds"
  ADD COLUMN "calendar_notify" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "calendar_invite_candidate" BOOLEAN NOT NULL DEFAULT true;
