-- 18.3 Store exam scores as DOUBLE PRECISION to support decimal values (e.g. 55.80).
-- INTEGER → DOUBLE PRECISION is an implicit cast in PostgreSQL; no USING clause needed.

ALTER TABLE "exam_attempts"
  ALTER COLUMN "auto_score"  TYPE DOUBLE PRECISION,
  ALTER COLUMN "total_score" TYPE DOUBLE PRECISION,
  ALTER COLUMN "max_score"   TYPE DOUBLE PRECISION;
