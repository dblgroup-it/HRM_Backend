-- Acknowledgement of the Company Code of Conduct: when it was sent, when the
-- candidate signed it, and where the completed form was filed on Drive.
ALTER TABLE "onboardings"
  ADD COLUMN IF NOT EXISTS "coc_sent_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "coc_signed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "coc_file_id" TEXT,
  ADD COLUMN IF NOT EXISTS "coc_url" TEXT;
