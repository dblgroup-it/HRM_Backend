-- The joining checklist becomes a catalogue of keyed slots.
--
-- Matching used to be on the document's label, so rewording a checklist item
-- orphaned every document already filed under the old words — a candidate's
-- file silently went back to incomplete. `doc_key` is stable and never shown;
-- `label` is now free text, and for the repeatable slots it holds the name
-- the candidate typed ("PMP", "Six Sigma Green Belt").
--
-- Also: the lab prints are expected on paper as well as uploaded, and the NID
-- particulars are typed next to the scan rather than read off it — those four
-- go onto the appointment letter and the payroll record.

ALTER TABLE "onboarding_docs"
  ADD COLUMN IF NOT EXISTS "doc_key" VARCHAR(60);

-- Labels are user-supplied now (certification names), so 100 was tight.
ALTER TABLE "onboarding_docs"
  ALTER COLUMN "label" TYPE VARCHAR(150);

ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "photos_hard_copy_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nid_name" VARCHAR(150),
  ADD COLUMN IF NOT EXISTS "nid_address" TEXT,
  ADD COLUMN IF NOT EXISTS "nid_dob" DATE,
  ADD COLUMN IF NOT EXISTS "nid_number" VARCHAR(40);

-- Everything already collected keeps counting. Mapped from the short labels
-- introduced in 20260920100000; anything else is left with a null key and
-- shows under "Other documents" rather than being lost.
UPDATE "onboarding_docs" SET "doc_key" = 'passport_photos'          WHERE "doc_key" IS NULL AND "label" = 'Passport Photographs';
UPDATE "onboarding_docs" SET "doc_key" = 'graduation_certificate'   WHERE "doc_key" IS NULL AND "label" = 'Academic Certificates';
UPDATE "onboarding_docs" SET "doc_key" = 'experience_certificates'  WHERE "doc_key" IS NULL AND "label" = 'Experience Certificates';
UPDATE "onboarding_docs" SET "doc_key" = 'nid_or_passport'          WHERE "doc_key" IS NULL AND "label" = 'National ID or Passport';
UPDATE "onboarding_docs" SET "doc_key" = 'residence_proof'          WHERE "doc_key" IS NULL AND "label" = 'Proof of Residence';
UPDATE "onboarding_docs" SET "doc_key" = 'signature'                WHERE "doc_key" IS NULL AND "label" = 'Signature';
UPDATE "onboarding_docs" SET "doc_key" = 'relieving_letter'         WHERE "doc_key" IS NULL AND "label" = 'Relieving Letter & Last Pay Slip';
UPDATE "onboarding_docs" SET "doc_key" = 'tin_copy'                 WHERE "doc_key" IS NULL AND "label" = 'TIN or Last Tax Return';
UPDATE "onboarding_docs" SET "doc_key" = 'salary_certificate'       WHERE "doc_key" IS NULL AND "label" = 'Salary Certificate';
UPDATE "onboarding_docs" SET "doc_key" = 'code_of_conduct'          WHERE "doc_key" IS NULL AND "label" = 'Code of Conduct (signed)';

CREATE INDEX IF NOT EXISTS "onboarding_docs_onboarding_id_doc_key_idx"
  ON "onboarding_docs" ("onboarding_id", "doc_key");
