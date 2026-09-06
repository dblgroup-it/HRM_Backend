-- Approval paths move from per (unit, source) to per (unit, requisition raiser).
--
-- Corporate HR nominates a unit's raisers — there can be several — and gives
-- each their own chain, so two people raising in the same unit can route to
-- different approvers. The source split (factory vs HO) is dropped: routing no
-- longer branches on where the requisition came from.
--
-- `levels` now holds only the intermediate approvers; a Corporate HR step is
-- appended automatically when a requisition is raised, so a path with zero
-- levels legitimately means "straight to Corporate HR".
--
-- Any existing paths cannot be mapped to a raiser (they were keyed on source),
-- so they are cleared and reconfigured in the UI.

DELETE FROM "approval_path_levels";
DELETE FROM "approval_paths";

-- AlterTable
DROP INDEX IF EXISTS "approval_paths_unit_id_source_key";
ALTER TABLE "approval_paths" DROP COLUMN "source";
ALTER TABLE "approval_paths" ADD COLUMN "raiser_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "approval_paths_raiser_id_idx" ON "approval_paths"("raiser_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_paths_unit_id_raiser_id_key" ON "approval_paths"("unit_id", "raiser_id");

-- AddForeignKey
ALTER TABLE "approval_paths" ADD CONSTRAINT "approval_paths_raiser_id_fkey" FOREIGN KEY ("raiser_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Factory HR is retired: it is no longer a routing concept, and the chain is a
-- list of named people rather than roles. Removing the role also removes its
-- assignments (and with them, those holders' Unit Config access for the unit).
-- Holders at time of removal are recorded in HRM_Backend/backups/.
DELETE FROM "role_assignments"
WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "key" = 'factory_hr');

DELETE FROM "roles" WHERE "key" = 'factory_hr';
