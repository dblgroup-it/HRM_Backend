-- Drop Requisition.source (factory / HO).
--
-- It no longer drives anything: approval routing is configured per raiser in
-- Approval Paths, and the old "Factory HR if factory, SBU Head if new+factory"
-- rules were removed with the hardcoded chain. The field was left on the form
-- purely as a label, so it is being retired rather than kept as dead data.
--
-- DESTRUCTIVE: existing requisitions lose their recorded factory/HO value.
-- deploy.sh takes a verified pg_dump first, which is the recovery path.
ALTER TABLE "requisitions" DROP COLUMN "source";

-- Nothing else references the enum (checked against information_schema).
DROP TYPE IF EXISTS "RequisitionSource";
