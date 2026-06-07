-- Track the raiser user id for notifications
ALTER TABLE "requisitions" ADD COLUMN "raised_by_id" TEXT;
