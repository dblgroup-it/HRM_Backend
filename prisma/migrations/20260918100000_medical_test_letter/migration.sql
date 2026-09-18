-- The pre-employment medical test letter.
--
-- HR sends a candidate for their medical with a letter carrying a reference
-- number, an appointment and the list of tests. The list depends on age: seven
-- below forty, eight at forty and above (S/Creatinine is the extra one).
--
-- Additive; every column is nullable and nothing already recorded changes.

ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "medical_ref_no"          VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "medical_exam_at"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "medical_venue"           TEXT,
  ADD COLUMN IF NOT EXISTS "medical_age_band"        VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "medical_letter_sent_at"  TIMESTAMP(3);

-- The reference serial.
--
-- A sequence rather than max()+1: two letters sent in the same second would
-- otherwise take the same number, and a medical reference is what the clinic
-- and HR's own register use to find a candidate.
--
-- Starts at 7200 because DBL's existing paper register is already in the 7000s
-- (7061 and 7126 are real letters). Starting at 1 would collide with numbers
-- already issued on paper. If the real next number differs, set it before the
-- first send and nothing else needs changing:
--     SELECT setval('medical_test_ref_seq', <next number> - 1, true);
CREATE SEQUENCE IF NOT EXISTS "medical_test_ref_seq" START WITH 7200 INCREMENT BY 1;

-- Two letters must never share a reference. Partial, so the many rows with no
-- letter yet do not all collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "onboardings_medical_ref_no_key"
  ON "onboardings" ("medical_ref_no")
  WHERE "medical_ref_no" IS NOT NULL;
