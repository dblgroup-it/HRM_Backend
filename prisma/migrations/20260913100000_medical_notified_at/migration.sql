-- Records when the medical team was told a candidate is waiting on them, so
-- the notification fires once rather than on every document verified.
ALTER TABLE "onboardings" ADD COLUMN "medical_notified_at" TIMESTAMP(3);
