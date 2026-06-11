-- AlterTable
ALTER TABLE "onboardings" ADD COLUMN     "cross_check" JSONB,
ADD COLUMN     "cross_checked_at" TIMESTAMP(3);
