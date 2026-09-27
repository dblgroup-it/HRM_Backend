-- The regret letter to a rejected candidate: who sent it and when.
-- Opt-in, sent at most once per candidate.
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "regret_sent_at" TIMESTAMP(3);
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "regret_sent_by_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "candidates"
    ADD CONSTRAINT "candidates_regret_sent_by_id_fkey"
    FOREIGN KEY ("regret_sent_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
