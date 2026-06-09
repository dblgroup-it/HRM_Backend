-- CreateEnum
CREATE TYPE "AssessmentType" AS ENUM ('WRITTEN', 'EXCEL', 'SKILL', 'VIVA');

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "talent_pool" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "committee_members" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'interviewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "committee_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rubric_criteria" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "max_score" INTEGER NOT NULL DEFAULT 10,
    "order_index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rubric_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_components" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "type" "AssessmentType" NOT NULL,
    "max_score" INTEGER NOT NULL DEFAULT 100,
    "order_index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "assessment_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "committee_members_user_id_idx" ON "committee_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "committee_members_requisition_id_user_id_key" ON "committee_members"("requisition_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_components_requisition_id_type_key" ON "assessment_components"("requisition_id", "type");

-- AddForeignKey
ALTER TABLE "committee_members" ADD CONSTRAINT "committee_members_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committee_members" ADD CONSTRAINT "committee_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "rubric_criteria_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_components" ADD CONSTRAINT "assessment_components_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
