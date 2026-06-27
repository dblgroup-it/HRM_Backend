/*
  Warnings:

  - You are about to drop the `screening_jobs` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "screening_jobs" DROP CONSTRAINT "screening_jobs_requisition_id_fkey";

-- DropTable
DROP TABLE "screening_jobs";
