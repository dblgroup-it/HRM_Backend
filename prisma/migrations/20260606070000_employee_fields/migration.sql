-- Capture richer employee fields from the ZingHR master
ALTER TABLE "employees" RENAME COLUMN "address" TO "location";
ALTER TABLE "employees" ADD COLUMN "section" TEXT;
ALTER TABLE "employees" ADD COLUMN "grade" TEXT;
ALTER TABLE "employees" ADD COLUMN "category" TEXT;
ALTER TABLE "employees" ADD COLUMN "gender" TEXT;
ALTER TABLE "employees" ADD COLUMN "date_of_birth" TIMESTAMP(3);
ALTER TABLE "employees" ADD COLUMN "exit_date" TIMESTAMP(3);
