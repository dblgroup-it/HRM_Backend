-- BDJobs v2 sends a profile picture. Kept in its own table so the image bytes
-- are never read along with a candidate list.
CREATE TABLE IF NOT EXISTS "candidate_photos" (
    "candidate_id" TEXT NOT NULL,
    "mime_type" VARCHAR(20) NOT NULL,
    "data" BYTEA NOT NULL,
    "source_url" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "candidate_photos_pkey" PRIMARY KEY ("candidate_id")
);

DO $$ BEGIN
  ALTER TABLE "candidate_photos"
    ADD CONSTRAINT "candidate_photos_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
