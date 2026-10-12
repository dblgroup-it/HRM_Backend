-- The IT request no longer carries "Approved by" (owner's decision,
-- 2026-10-12): it is not asked for in the Notify IT dialog nor printed in
-- the email, so the column has nothing to hold.
ALTER TABLE "it_account_requests" DROP COLUMN IF EXISTS "approved_by";
