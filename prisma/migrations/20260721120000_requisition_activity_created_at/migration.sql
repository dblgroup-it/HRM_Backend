-- 12.2 Rename the 'at' column to 'created_at' for clarity and consistency.

ALTER TABLE "requisition_activities" RENAME COLUMN "at" TO "created_at";

DROP INDEX IF EXISTS "requisition_activities_at_idx";
CREATE INDEX "requisition_activities_created_at_idx" ON "requisition_activities"("created_at");
