-- Notify IT no longer copies the requester automatically (owner's decision,
-- 2026-10-13). HR may copy people picked from the employee directory, or
-- nobody. Who was copied is kept, so IT's "completed" reply reaches them too
-- and a re-send starts from the same list: [{ code, name, designation, email }].
ALTER TABLE "it_account_requests" ADD COLUMN IF NOT EXISTS "cc" JSONB NOT NULL DEFAULT '[]';
