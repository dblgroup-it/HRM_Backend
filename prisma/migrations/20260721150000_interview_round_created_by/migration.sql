-- 16.2 Track who scheduled an interview round.

ALTER TABLE "interview_rounds"
  ADD COLUMN "created_by_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL;
