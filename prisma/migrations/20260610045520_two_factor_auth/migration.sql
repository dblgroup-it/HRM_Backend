-- AlterTable
ALTER TABLE "users" ADD COLUMN     "otp_expires_at" TIMESTAMP(3),
ADD COLUMN     "otp_hash" TEXT,
ADD COLUMN     "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "two_factor_method" TEXT,
ADD COLUMN     "two_factor_secret" TEXT;
