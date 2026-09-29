-- Gender for the indicator on a candidate's row, and who on the factory side
-- sent the CV in.
ALTER TABLE "candidates" ADD COLUMN "gender" VARCHAR(10);
ALTER TABLE "candidates" ADD COLUMN "added_by_role" VARCHAR(30);

-- "Applied before" matches on email or on the last ten digits of the mobile,
-- across every requisition. Expression indexes so that lookup is not a scan.
CREATE INDEX "candidates_email_key_idx" ON "candidates" (lower(btrim("email")));
CREATE INDEX "candidates_phone_key_idx" ON "candidates" (right(regexp_replace(coalesce("phone", ''), '\D', '', 'g'), 10));

-- BDJobs already sends gender inside the stored profile: copy it across.
UPDATE "candidates"
SET "gender" = lower("cv_profile"->'personal'->>'gender')
WHERE "gender" IS NULL
  AND lower("cv_profile"->'personal'->>'gender') IN ('male', 'female');
