-- Rename units.code -> employee_code_prefix (preserve existing values)
ALTER TABLE "units" RENAME COLUMN "code" TO "employee_code_prefix";
ALTER INDEX "units_code_key" RENAME TO "units_employee_code_prefix_key";

-- SyncLog: live-progress columns + default status
ALTER TABLE "sync_logs" ADD COLUMN "total" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sync_logs" ADD COLUMN "processed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sync_logs" ALTER COLUMN "status" SET DEFAULT 'running';
