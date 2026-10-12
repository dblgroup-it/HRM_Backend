-- "Notify IT" (onboarding's last step): the email asking IT to create a new
-- hire's work email account — and, for a replacement, to delete the leaver's —
-- sent to the address set on Integrations, and IT's answer from the link in
-- it. One row per onboarding; sending again updates it with a fresh link.
CREATE TABLE "it_account_requests" (
    "id" TEXT NOT NULL,
    "onboarding_id" TEXT NOT NULL,
    "sent_to" VARCHAR(500) NOT NULL,
    "subject" VARCHAR(300) NOT NULL,
    "employee_name" VARCHAR(150) NOT NULL,
    "preferred_email" VARCHAR(254),
    "platform" VARCHAR(40) NOT NULL,
    "approved_by" TEXT,
    "purpose" TEXT,
    "deletions" JSONB NOT NULL DEFAULT '[]',
    "body_text" TEXT NOT NULL,
    "message_id" VARCHAR(300),
    "token_hash" VARCHAR(64) NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "sent_by_id" TEXT,
    "sent_by_name" VARCHAR(150) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "completed_at" TIMESTAMP(3),
    "completed_by_name" VARCHAR(150),
    "created_email" VARCHAR(254),
    "deletions_done" JSONB,
    "completion_note" TEXT,
    "confirmation_sent_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_reason" VARCHAR(200),
    CONSTRAINT "it_account_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "it_account_requests_onboarding_id_key" ON "it_account_requests"("onboarding_id");
CREATE UNIQUE INDEX "it_account_requests_token_hash_key" ON "it_account_requests"("token_hash");

ALTER TABLE "it_account_requests" ADD CONSTRAINT "it_account_requests_onboarding_id_fkey"
    FOREIGN KEY ("onboarding_id") REFERENCES "onboardings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "it_account_requests" ADD CONSTRAINT "it_account_requests_sent_by_id_fkey"
    FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
