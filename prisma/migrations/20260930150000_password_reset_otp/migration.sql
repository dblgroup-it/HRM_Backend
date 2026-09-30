-- Forgot password by emailed code. Kept apart from otp_hash / otp_expires_at
-- (the sign-in second factor) so requesting a reset never overwrites a code
-- somebody is about to type at sign-in.
ALTER TABLE "users" ADD COLUMN "reset_otp_hash" VARCHAR(100);
ALTER TABLE "users" ADD COLUMN "reset_otp_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "reset_otp_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "reset_otp_sent_at" TIMESTAMP(3);
