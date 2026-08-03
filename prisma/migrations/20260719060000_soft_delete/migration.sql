-- Soft delete: add deleted_at to requisitions and candidates.

ALTER TABLE "requisitions" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "requisitions_deleted_at_idx" ON "requisitions"("deleted_at");

ALTER TABLE "candidates" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "candidates_deleted_at_idx" ON "candidates"("deleted_at");
