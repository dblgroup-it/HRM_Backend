-- Approval paths become per (unit, source).
--
-- `source` (FACTORY | HO) is chosen by the raiser and genuinely varies within a
-- unit, so one chain per unit cannot express rules like "Factory HR signs only
-- on factory-raised requisitions". Each unit now configures a Factory chain and
-- an HO chain independently.
--
-- Existing rows default to FACTORY (the common case) before the column is made
-- strict, so any already-configured path stays valid.

-- AlterTable
ALTER TABLE "approval_paths" ADD COLUMN "source" "RequisitionSource";
UPDATE "approval_paths" SET "source" = 'FACTORY' WHERE "source" IS NULL;
ALTER TABLE "approval_paths" ALTER COLUMN "source" SET NOT NULL;

-- One path per unit becomes one path per unit *per source*.
DROP INDEX IF EXISTS "approval_paths_unit_id_key";

-- CreateIndex
CREATE INDEX "approval_paths_unit_id_idx" ON "approval_paths"("unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_paths_unit_id_source_key" ON "approval_paths"("unit_id", "source");
