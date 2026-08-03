-- 15.2 Track when a notification was first seen (bell opened, item visible).
-- Distinct from 'read' (explicitly marked as read).

ALTER TABLE "notifications" ADD COLUMN "seen_at" TIMESTAMP(3);
