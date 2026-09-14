-- Track re-sends of an interview delegation.
--
-- `interview_delegations` rows are upserted, so handing the same candidate to
-- the same interviewer a second time silently overwrote the note and left
-- `created_at` at the original hand-off. Corporate HR could chase the same
-- person repeatedly with no record that they had, and no way to tell a fresh
-- assignment from one that has been sitting there for a fortnight.
--
-- Both columns have defaults, so this cannot fail and existing rows read
-- correctly: every delegation that already exists was sent exactly once, and
-- `created_at` is when. The application backfills nothing.

ALTER TABLE "interview_delegations"
  ADD COLUMN IF NOT EXISTS "send_count" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing rows: the last send IS the first send. Without this they would all
-- claim to have been re-sent at migration time.
UPDATE "interview_delegations" SET "last_sent_at" = "created_at";

-- Supports the workload roll-up: "how many open delegations does this person
-- hold, and how long has the oldest been waiting?"
CREATE INDEX IF NOT EXISTS "interview_delegations_delegated_to_last_sent_idx"
  ON "interview_delegations" ("delegated_to_id", "last_sent_at")
  WHERE "revoked_at" IS NULL;
