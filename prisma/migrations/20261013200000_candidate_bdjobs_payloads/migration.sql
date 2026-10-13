-- The application exactly as BDJobs last sent it, one row per candidate
-- (2026-10-13). Until now the payload was mapped into `cv_profile` and
-- thrown away, so a mapping bug lost data for good — twice: the list rows
-- emptied by the validation pipe, and the flat profile's trainings,
-- languages, references, photo and personal details. With the payload kept,
-- a fix can rebuild every CV (scripts/rebuild-bdjobs-cvs.ts) without asking
-- BDJobs to send anything again. Its own table, like candidate_photos, so
-- candidate lists never load it. Inline image bytes are not kept here — the
-- photo has its own table — and neither is the signature timestamp.
CREATE TABLE IF NOT EXISTS "candidate_bdjobs_payloads" (
  "candidate_id"  TEXT NOT NULL,
  "payload"       JSONB NOT NULL,
  "received_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "refresh_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "candidate_bdjobs_payloads_pkey" PRIMARY KEY ("candidate_id"),
  CONSTRAINT "candidate_bdjobs_payloads_candidate_id_fkey" FOREIGN KEY ("candidate_id")
    REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
