-- First-login password change + account lockout.
--
-- Three columns on `users`, all with defaults, so this migration cannot fail
-- and cannot lock anyone out on its own:
--
--   must_change_password   defaults FALSE  -> every existing account keeps
--                          signing in exactly as it does today. Accounts that
--                          should be forced to change are selected explicitly,
--                          by an operator, in a separate reviewed statement
--                          (see FINAL_GO_LIVE_GATE.md). Rolling it out is a
--                          business decision about when to disrupt ~4,600
--                          people, not something a deployment should decide.
--
--   failed_login_attempts  defaults 0      -> nobody starts part-way to a lock.
--   locked_until           NULL            -> nobody starts locked.
--
-- Reversible: dropping these three columns restores the previous behaviour
-- exactly, because the application treats their defaults as "as before".

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMP(3);

-- Finding a locked account is a per-login lookup by id, so no index is needed;
-- this one supports the operational question "who is locked right now?".
CREATE INDEX IF NOT EXISTS "users_locked_until_idx"
  ON "users" ("locked_until")
  WHERE "locked_until" IS NOT NULL;
