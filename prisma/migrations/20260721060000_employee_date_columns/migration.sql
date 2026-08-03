-- Change date_of_birth, joining_date, exit_date from TIMESTAMP to DATE.
-- These are calendar dates with no time component.

ALTER TABLE "employees" ALTER COLUMN "date_of_birth" TYPE DATE USING "date_of_birth"::date;
ALTER TABLE "employees" ALTER COLUMN "joining_date"  TYPE DATE USING "joining_date"::date;
ALTER TABLE "employees" ALTER COLUMN "exit_date"     TYPE DATE USING "exit_date"::date;
