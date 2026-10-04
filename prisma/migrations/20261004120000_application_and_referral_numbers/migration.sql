-- Application numbers (APP-<year>-<n>) and employee referrals (REF-<year>-<n>).

-- Every candidate row is one application, however it arrived, so each gets a
-- number from one sequence. Existing rows are numbered in the order they came
-- in; new rows take the next number on insert.
CREATE SEQUENCE "candidates_application_no_seq" AS INTEGER;
ALTER TABLE "candidates" ADD COLUMN "application_no" INTEGER;
UPDATE "candidates" c
SET "application_no" = n.rn
FROM (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn
  FROM "candidates"
) n
WHERE c."id" = n."id";
SELECT setval(
  '"candidates_application_no_seq"',
  COALESCE((SELECT max("application_no") FROM "candidates"), 0) + 1,
  false
);
ALTER TABLE "candidates"
  ALTER COLUMN "application_no" SET DEFAULT nextval('"candidates_application_no_seq"'),
  ALTER COLUMN "application_no" SET NOT NULL;
ALTER SEQUENCE "candidates_application_no_seq" OWNED BY "candidates"."application_no";
CREATE UNIQUE INDEX "candidates_application_no_key" ON "candidates"("application_no");

-- One employee referral: one or several candidates sent in together. Earlier
-- referrals are not backfilled — nobody is written to about a referral made
-- before these letters existed.
CREATE TABLE "candidate_referrals" (
    "id" TEXT NOT NULL,
    "reference_no" SERIAL NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "referrer_code" VARCHAR(20) NOT NULL,
    "referrer_name" VARCHAR(150) NOT NULL,
    "created_by_id" TEXT,
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "candidate_referrals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "candidate_referrals_reference_no_key" ON "candidate_referrals"("reference_no");
CREATE INDEX "candidate_referrals_requisition_id_idx" ON "candidate_referrals"("requisition_id");
CREATE INDEX "candidate_referrals_notified_at_created_at_idx" ON "candidate_referrals"("notified_at", "created_at");
ALTER TABLE "candidate_referrals"
  ADD CONSTRAINT "candidate_referrals_requisition_id_fkey"
  FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "candidates" ADD COLUMN "referral_id" TEXT;
CREATE INDEX "candidates_referral_id_idx" ON "candidates"("referral_id");
ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_referral_id_fkey"
  FOREIGN KEY ("referral_id") REFERENCES "candidate_referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
