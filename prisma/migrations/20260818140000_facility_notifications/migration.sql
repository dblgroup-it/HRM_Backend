-- CreateTable
CREATE TABLE "facility_notifications" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "facility_key" VARCHAR(20) NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "recipient_name" VARCHAR(150) NOT NULL,
    "recipient_email" VARCHAR(254) NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "sent_by_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),
    "confirm_note" TEXT,
    CONSTRAINT "facility_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "facility_notifications_token_key" ON "facility_notifications"("token");

-- CreateIndex
CREATE UNIQUE INDEX "facility_notifications_candidate_id_facility_key_key" ON "facility_notifications"("candidate_id", "facility_key");

-- AddForeignKey
ALTER TABLE "facility_notifications" ADD CONSTRAINT "facility_notifications_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "facility_notifications" ADD CONSTRAINT "facility_notifications_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "facility_notifications" ADD CONSTRAINT "facility_notifications_sent_by_id_fkey"
    FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
