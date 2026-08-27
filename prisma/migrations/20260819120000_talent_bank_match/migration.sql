-- CreateTable
CREATE TABLE "talent_bank_matches" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "relevance" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "talent_bank_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "talent_bank_matches_requisition_id_idx" ON "talent_bank_matches"("requisition_id");

-- CreateIndex
CREATE INDEX "talent_bank_matches_candidate_id_idx" ON "talent_bank_matches"("candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "talent_bank_matches_requisition_id_candidate_id_key" ON "talent_bank_matches"("requisition_id", "candidate_id");

-- AddForeignKey
ALTER TABLE "talent_bank_matches" ADD CONSTRAINT "talent_bank_matches_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_bank_matches" ADD CONSTRAINT "talent_bank_matches_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
