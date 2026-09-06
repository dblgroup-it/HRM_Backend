-- Configurable per-unit approval paths + Corporate Recruiter handoff.
--
-- 1. approval_steps gains a named approver and `role` becomes nullable.
--    Existing rows keep their role and get a NULL approver, so legacy chains
--    (and the CHRO step appended on escalation) keep routing by role.
-- 2. requisitions gains the assigned Corporate Recruiter.
-- 3. approval_paths / approval_path_levels hold the per-unit configuration.

-- AlterTable
ALTER TABLE "approval_steps" ADD COLUMN     "approver_user_id" TEXT,
ALTER COLUMN "role" DROP NOT NULL;

-- AlterTable
ALTER TABLE "requisitions" ADD COLUMN     "recruiter_id" TEXT,
ADD COLUMN     "recruiter_assigned_at" TIMESTAMP(3),
ADD COLUMN     "recruiter_assigned_by_id" TEXT;

-- CreateTable
CREATE TABLE "approval_paths" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_path_levels" (
    "id" TEXT NOT NULL,
    "path_id" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "subtitle" VARCHAR(200) NOT NULL DEFAULT '',

    CONSTRAINT "approval_path_levels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_paths_unit_id_key" ON "approval_paths"("unit_id");

-- CreateIndex
CREATE INDEX "approval_path_levels_user_id_idx" ON "approval_path_levels"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_path_levels_path_id_order_index_key" ON "approval_path_levels"("path_id", "order_index");

-- CreateIndex
CREATE INDEX "approval_steps_approver_user_id_idx" ON "approval_steps"("approver_user_id");

-- CreateIndex
CREATE INDEX "requisitions_recruiter_id_idx" ON "requisitions"("recruiter_id");

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_recruiter_id_fkey" FOREIGN KEY ("recruiter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_recruiter_assigned_by_id_fkey" FOREIGN KEY ("recruiter_assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_paths" ADD CONSTRAINT "approval_paths_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_paths" ADD CONSTRAINT "approval_paths_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_path_levels" ADD CONSTRAINT "approval_path_levels_path_id_fkey" FOREIGN KEY ("path_id") REFERENCES "approval_paths"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_path_levels" ADD CONSTRAINT "approval_path_levels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
