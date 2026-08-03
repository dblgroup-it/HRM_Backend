-- 19.1 Evaluation.total → DOUBLE PRECISION for decimal scores (e.g. 55.80).
-- INTEGER → DOUBLE PRECISION is an implicit cast; no USING clause needed.
ALTER TABLE "evaluations" ALTER COLUMN "total" TYPE DOUBLE PRECISION;

-- 20.1 EvaluationToken.status → typed enum.
CREATE TYPE "EvalTokenStatus" AS ENUM ('sent', 'opened', 'submitted');

ALTER TABLE "evaluation_tokens" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "evaluation_tokens" ALTER COLUMN "status" TYPE "EvalTokenStatus" USING "status"::"EvalTokenStatus";
ALTER TABLE "evaluation_tokens" ALTER COLUMN "status" SET DEFAULT 'sent'::"EvalTokenStatus";
