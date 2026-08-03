-- 11.1 Change vacant_date from TIMESTAMP to DATE.
ALTER TABLE "requisitions" ALTER COLUMN "vacant_date" TYPE DATE USING "vacant_date"::date;

-- 11.2 Rename when_needed_date to needed_date and change to DATE.
ALTER TABLE "requisitions" RENAME COLUMN "when_needed_date" TO "needed_date";
ALTER TABLE "requisitions" ALTER COLUMN "needed_date" TYPE DATE USING "needed_date"::date;
