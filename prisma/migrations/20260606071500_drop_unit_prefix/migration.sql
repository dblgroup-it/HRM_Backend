-- Remove the unused per-unit employee-code prefix
DROP INDEX IF EXISTS "units_employee_code_prefix_key";
ALTER TABLE "units" DROP COLUMN IF EXISTS "employee_code_prefix";
