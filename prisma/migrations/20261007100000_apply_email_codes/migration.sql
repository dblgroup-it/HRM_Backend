-- The careers-page application proves its email address with a six-digit
-- code (candidates/apply-email-verification.ts). One row per address holds
-- the live code — hashed — and how many have been sent this hour; a resend
-- replaces it. Rows untouched for a day are deleted nightly.
CREATE TABLE "apply_email_codes" (
    "email" VARCHAR(160) NOT NULL,
    "code_hash" TEXT,
    "expires_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "window_start" TIMESTAMP(3),
    "window_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "apply_email_codes_pkey" PRIMARY KEY ("email")
);
CREATE INDEX "apply_email_codes_updated_at_idx" ON "apply_email_codes"("updated_at");
