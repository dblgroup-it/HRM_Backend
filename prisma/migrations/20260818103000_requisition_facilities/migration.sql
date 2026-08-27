-- AlterTable
ALTER TABLE "requisitions" ADD COLUMN "facilities" JSONB;

-- AlterTable
ALTER TABLE "requisitions" DROP COLUMN "computer";
ALTER TABLE "requisitions" DROP COLUMN "computer_reason";
ALTER TABLE "requisitions" DROP COLUMN "seating";

-- DropEnum
DROP TYPE "ComputerRequirement";
DROP TYPE "SeatingArrangement";
