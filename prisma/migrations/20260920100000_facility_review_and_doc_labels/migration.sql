-- Two changes to the joining step.
--
-- 1. Facility requirements become a step somebody signs off, rather than one
--    that settles by itself. A hire entitled to nothing used to fall straight
--    from document verification into medical with the panel never opened.
-- 2. The joining-document checklist gets short labels. The label is the key
--    these rows are filed and matched under, so documents already collected
--    are renamed with it — otherwise every in-flight candidate would read as
--    missing every document they had already sent in.

ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "facilities_reviewed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "facilities_reviewed_by_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'onboardings_facilities_reviewed_by_id_fkey'
  ) THEN
    ALTER TABLE "onboardings"
      ADD CONSTRAINT "onboardings_facilities_reviewed_by_id_fkey"
      FOREIGN KEY ("facilities_reviewed_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "onboardings_facilities_reviewed_by_id_idx"
  ON "onboardings" ("facilities_reviewed_by_id");

-- Everything already in flight keeps moving. The gate is new, and applying it
-- retrospectively would drop candidates out of the medical queue overnight
-- for a review nobody was ever asked for.
UPDATE "onboardings"
   SET "facilities_reviewed_at" = COALESCE("updated_at", "created_at", NOW())
 WHERE "facilities_reviewed_at" IS NULL;

-- Old label -> new label. Left-anchored exact matches: a candidate's document
-- is only renamed if it was filed under the wording this replaces.
UPDATE "onboarding_docs" SET "label" = 'Passport Photographs'
 WHERE "label" = 'Four Passport-size photographs, white background (lab print)';
UPDATE "onboarding_docs" SET "label" = 'Academic Certificates'
 WHERE "label" = 'All relevant education certificates and marksheets (main copy & photocopy)';
UPDATE "onboarding_docs" SET "label" = 'Experience Certificates'
 WHERE "label" = 'Experience certificates';
UPDATE "onboarding_docs" SET "label" = 'National ID or Passport'
 WHERE "label" = 'Copy of NID & Birth Registration / Passport (at least one)';
UPDATE "onboarding_docs" SET "label" = 'Proof of Residence'
 WHERE "label" = 'Copy of residence proof (any government bill)';
UPDATE "onboarding_docs" SET "label" = 'Signature'
 WHERE "label" = 'Signature (3:1 image)';
UPDATE "onboarding_docs" SET "label" = 'Relieving Letter & Last Pay Slip'
 WHERE "label" = 'Relieving letter and last pay slip from the previous employer (experienced candidates)';
UPDATE "onboarding_docs" SET "label" = 'TIN or Last Tax Return'
 WHERE "label" = 'Copy of TIN / last tax return submission (experienced candidates, if any)';
UPDATE "onboarding_docs" SET "label" = 'Salary Certificate'
 WHERE "label" = 'Pay slip / salary certificate / statement (experienced candidates)';
