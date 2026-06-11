-- CreateIndex
CREATE INDEX "candidates_stage_idx" ON "candidates"("stage");

-- CreateIndex
CREATE INDEX "candidates_created_at_idx" ON "candidates"("created_at");

-- CreateIndex
CREATE INDEX "employees_unit_name_idx" ON "employees"("unit_name");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "requisition_activities_at_idx" ON "requisition_activities"("at");

-- CreateIndex
CREATE INDEX "requisitions_created_at_idx" ON "requisitions"("created_at");
