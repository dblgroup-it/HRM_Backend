-- The interviewer's own verdict, recorded beside their marks.
--
-- A scorecard says how the candidate did on ten criteria; it does not say what
-- the person in the room thinks should happen next, and that judgement was
-- being carried by hand — in the comments box, in a corridor, or not at all.
-- Head of Talent Acquisition then decided from numbers alone.
--
-- Three answers, because "no" and "not for this post" are different outcomes
-- and the second one is how the Talent Bank fills up:
--   SELECT       — put them through
--   REJECT       — do not proceed
--   TALENT_POOL  — not for this role, worth keeping
--
-- It is a suggestion, not a decision: the recruiter still records the actual
-- outcome. Nullable, because every evaluation submitted before today has no
-- answer and inventing one would be a lie about what an interviewer said.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvaluationRecommendation') THEN
    CREATE TYPE "EvaluationRecommendation" AS ENUM ('SELECT', 'REJECT', 'TALENT_POOL');
  END IF;
END
$$;

ALTER TABLE "evaluations"
  ADD COLUMN IF NOT EXISTS "recommendation" "EvaluationRecommendation";
