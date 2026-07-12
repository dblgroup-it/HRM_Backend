-- CreateTable
CREATE TABLE "evaluation_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "panelist_user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "opened_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_tokens_token_key" ON "evaluation_tokens"("token");

-- CreateIndex
CREATE INDEX "evaluation_tokens_round_id_idx" ON "evaluation_tokens"("round_id");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_tokens_round_id_panelist_user_id_key" ON "evaluation_tokens"("round_id", "panelist_user_id");

-- AddForeignKey
ALTER TABLE "evaluation_tokens" ADD CONSTRAINT "evaluation_tokens_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "interview_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_tokens" ADD CONSTRAINT "evaluation_tokens_panelist_user_id_fkey" FOREIGN KEY ("panelist_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
