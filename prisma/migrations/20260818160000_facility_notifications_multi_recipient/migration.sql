-- Allow notifying multiple recipients per (candidate, facility) — HR can pick
-- one or several people at once; any one confirming marks it arranged.
DROP INDEX "facility_notifications_candidate_id_facility_key_key";

CREATE INDEX "facility_notifications_candidate_id_facility_key_idx" ON "facility_notifications"("candidate_id", "facility_key");
