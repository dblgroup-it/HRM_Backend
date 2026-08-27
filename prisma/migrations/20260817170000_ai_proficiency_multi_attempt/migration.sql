-- DropIndex
DROP INDEX "ai_proficiency_attempts_candidate_id_key";

-- CreateIndex
CREATE INDEX "ai_proficiency_attempts_candidate_id_idx" ON "ai_proficiency_attempts"("candidate_id");
