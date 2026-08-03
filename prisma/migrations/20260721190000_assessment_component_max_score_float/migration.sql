-- 25.2 AssessmentComponent.max_score → DOUBLE PRECISION for decimal values (e.g. 85.50).
-- INTEGER → DOUBLE PRECISION is an implicit cast; no USING clause needed.
ALTER TABLE "assessment_components" ALTER COLUMN "max_score" TYPE DOUBLE PRECISION;
