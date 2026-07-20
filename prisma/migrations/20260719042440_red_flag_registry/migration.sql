-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "is_red_flagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "red_flag_reason" TEXT,
ADD COLUMN     "red_flagged_at" TIMESTAMP(3),
ADD COLUMN     "red_flagged_by_id" TEXT;

-- CreateTable
CREATE TABLE "red_flag_registry" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "reason" TEXT NOT NULL,
    "flagged_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "red_flag_registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "red_flag_registry_email_key" ON "red_flag_registry"("email");

-- CreateIndex
CREATE UNIQUE INDEX "red_flag_registry_phone_key" ON "red_flag_registry"("phone");

-- CreateIndex
CREATE INDEX "red_flag_registry_email_idx" ON "red_flag_registry"("email");

-- CreateIndex
CREATE INDEX "red_flag_registry_phone_idx" ON "red_flag_registry"("phone");
