-- Let a facility request be refused, not just confirmed.
--
-- Until now the only answer was yes. Someone with no desk free, no vehicle
-- available, or who was simply the wrong person to ask, had no way to say so:
-- the request sat "pending" indefinitely and HR could not tell a refusal from
-- an unread email.
--
-- A separate timestamp rather than a status column, for two reasons: a row can
-- never be both confirmed and declined, and every existing
-- `confirmed_at IS NOT NULL` check keeps its exact meaning without being
-- rewritten.
ALTER TABLE "facility_notifications"
  ADD COLUMN IF NOT EXISTS "declined_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "decline_reason" TEXT;
