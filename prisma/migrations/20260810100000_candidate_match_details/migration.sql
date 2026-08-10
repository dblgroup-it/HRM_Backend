-- Per-criterion AI screening breakdown stored as JSONB.
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "match_details" JSONB;
