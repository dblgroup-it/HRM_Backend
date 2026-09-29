-- Rescheduling an arranged interview: the new time is on scheduled_at as
-- before; these record that it moved, from when, why and by whom.
ALTER TABLE "interview_rounds" ADD COLUMN "reschedule_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "interview_rounds" ADD COLUMN "previous_scheduled_at" TIMESTAMP(3);
ALTER TABLE "interview_rounds" ADD COLUMN "reschedule_reason" VARCHAR(300);
ALTER TABLE "interview_rounds" ADD COLUMN "rescheduled_at" TIMESTAMP(3);
ALTER TABLE "interview_rounds" ADD COLUMN "rescheduled_by_name" VARCHAR(150);
