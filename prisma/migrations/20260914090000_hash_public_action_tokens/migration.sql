-- Stage 1 of 2: store public action tokens as a SHA-256 hash.
--
-- These five tokens stand in for a login on a public page — an evaluation
-- link, a candidate's onboarding page, a board vote, a facility confirmation,
-- a proficiency test. They were stored as the raw value, so read access to the
-- database was enough to cast a board member's vote or open a candidate's
-- onboarding record.
--
-- This stage is purely additive and breaks nothing:
--
--   * `token_hash` is added, nullable and unique. New tokens write only the
--     hash; the raw value exists solely in the emailed link.
--   * `token` is made NULLABLE but is NOT dropped and NOT cleared. Every link
--     already in somebody's inbox keeps working: the application looks up the
--     hash first and falls back to the raw column where no hash is recorded,
--     then upgrades that row in place the first time it is used.
--
-- Stage 2 (a separate migration, only after the transition window below) drops
-- the `token` columns. DO NOT run it early.
--
-- Transition window — the longest a legacy link can still be valid:
--   evaluation_tokens      expires_at set to 48h after the interview, or 7 days
--   board_approval_votes   token_expires_at, 30 days on sheet sends
--   facility_notifications token_expires_at
--   ai_proficiency_attempts no expiry — bounded by the attempt being submitted
--   onboardings            NO EXPIRY — the long pole; see the runbook
--
-- Practical window: 30 days covers every expiring token. Onboarding links do
-- not expire at all, so those rows are migrated on first use and the residue
-- should be swept explicitly before stage 2.

ALTER TABLE "evaluation_tokens"       ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "onboardings"             ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "ai_proficiency_attempts" ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "board_approval_votes"    ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "facility_notifications"  ALTER COLUMN "token" DROP NOT NULL;

ALTER TABLE "evaluation_tokens"       ADD COLUMN IF NOT EXISTS "token_hash" VARCHAR(64);
ALTER TABLE "onboardings"             ADD COLUMN IF NOT EXISTS "token_hash" VARCHAR(64);
ALTER TABLE "ai_proficiency_attempts" ADD COLUMN IF NOT EXISTS "token_hash" VARCHAR(64);
ALTER TABLE "board_approval_votes"    ADD COLUMN IF NOT EXISTS "token_hash" VARCHAR(64);
ALTER TABLE "facility_notifications"  ADD COLUMN IF NOT EXISTS "token_hash" VARCHAR(64);

-- Unique so a hash collision or a duplicated write is rejected rather than
-- silently giving two records the same credential.
CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_tokens_token_hash_key"       ON "evaluation_tokens" ("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "onboardings_token_hash_key"             ON "onboardings" ("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_proficiency_attempts_token_hash_key" ON "ai_proficiency_attempts" ("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "board_approval_votes_token_hash_key"    ON "board_approval_votes" ("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "facility_notifications_token_hash_key"  ON "facility_notifications" ("token_hash");
