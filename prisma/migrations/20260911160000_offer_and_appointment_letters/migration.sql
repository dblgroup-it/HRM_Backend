-- Formal offer and appointment letters, in DBL's two house formats.
--
-- Until now "sending the offer" was an email with an accept link and no letter
-- at all. These columns hold what the printed letter needs: which format, the
-- reference number, the dates, and the terms that differ between a junior
-- appointment (probation + notice) and a senior one (job location + benefits).
--
-- The rendered letter is snapshotted on send, because a letter is a document
-- the candidate holds a copy of — it must not change afterwards because a
-- template or a salary did.
ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "offer_format"           VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "offer_ref"              VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "offer_joining_date"     DATE,
  ADD COLUMN IF NOT EXISTS "offer_job_location"     VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "offer_probation_months" INTEGER,
  ADD COLUMN IF NOT EXISTS "offer_notice_days"      INTEGER,
  ADD COLUMN IF NOT EXISTS "offer_benefits"         TEXT[],
  ADD COLUMN IF NOT EXISTS "offer_letter_html"      TEXT,
  ADD COLUMN IF NOT EXISTS "candidate_address"      VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "appointment_ref"        VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "appointment_sent_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "appointment_letter_html" TEXT;
