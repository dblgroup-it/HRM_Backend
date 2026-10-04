-- "Notify on calendar" is the candidate's calendar invite only; the panel's
-- invite does not depend on it. A round arranged with it off also kept the
-- candidate off the invite, so that is carried over before the round-wide
-- flag goes.
UPDATE "interview_rounds" SET "calendar_invite_candidate" = false WHERE "calendar_notify" = false;
ALTER TABLE "interview_rounds" DROP COLUMN "calendar_notify";
