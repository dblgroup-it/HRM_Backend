-- CreateTable
CREATE TABLE "onboardings" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'docs_pending',
    "offer_sent_at" TIMESTAMP(3),
    "offer_accepted_at" TIMESTAMP(3),
    "medical_status" TEXT NOT NULL DEFAULT 'pending',
    "medical_note" TEXT,
    "medical_cleared_at" TIMESTAMP(3),
    "hr_verified_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "it_email" TEXT,
    "it_asset_id" TEXT,
    "it_notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboardings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_docs" (
    "id" TEXT NOT NULL,
    "onboarding_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ai_extract" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_docs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboardings_candidate_id_key" ON "onboardings"("candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboardings_token_key" ON "onboardings"("token");

-- CreateIndex
CREATE INDEX "onboarding_docs_onboarding_id_idx" ON "onboarding_docs"("onboarding_id");

-- AddForeignKey
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_docs" ADD CONSTRAINT "onboarding_docs_onboarding_id_fkey" FOREIGN KEY ("onboarding_id") REFERENCES "onboardings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
