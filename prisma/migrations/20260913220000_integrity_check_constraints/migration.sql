-- Data-integrity guards for states the application treats as impossible.
--
-- Before this migration the database had ZERO check constraints: every rule
-- below lived only in TypeScript, so a bug, a console session, a script or a
-- future endpoint could write a negative salary or a mark above the paper
-- total and nothing would notice until someone read it off a printed sheet.
--
-- Every constraint is added NOT VALID on purpose. NOT VALID enforces the rule
-- on every INSERT and UPDATE from this moment on, but does not scan the rows
-- already there — so this migration cannot fail on legacy data and cannot take
-- a write lock long enough to matter on a live database. Existing rows are
-- checked separately, when someone is watching:
--
--   ALTER TABLE positions VALIDATE CONSTRAINT positions_filled_within_sanctioned;
--
-- Run those VALIDATE statements by hand after deploying, one at a time. A
-- failure names the offending row and changes nothing.

-- Organogram seats: you cannot fill more seats than are sanctioned, and
-- neither number can go negative. `vacant` is derived from these two.
ALTER TABLE "positions"
  ADD CONSTRAINT "positions_sanctioned_non_negative"
  CHECK ("sanctioned" >= 0) NOT VALID;

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_filled_non_negative"
  CHECK ("filled" >= 0) NOT VALID;

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_filled_within_sanctioned"
  CHECK ("filled" <= "sanctioned") NOT VALID;

-- A requisition for zero or fewer people is not a requisition.
ALTER TABLE "requisitions"
  ADD CONSTRAINT "requisitions_required_posts_positive"
  CHECK ("required_posts" > 0) NOT VALID;

ALTER TABLE "requisitions"
  ADD CONSTRAINT "requisitions_total_vacant_non_negative"
  CHECK ("total_vacant_posts" >= 0) NOT VALID;

-- Pay is never negative, and a mark can never exceed its own paper total.
-- Each comparison is written to pass when either side is NULL, because these
-- columns are filled in progressively as HR works through the form.
ALTER TABLE "salary_fixations"
  ADD CONSTRAINT "salary_fixations_amounts_non_negative"
  CHECK (
    ("proposed_salary" IS NULL OR "proposed_salary" >= 0) AND
    ("proposed_salary_override" IS NULL OR "proposed_salary_override" >= 0)
  ) NOT VALID;

ALTER TABLE "salary_fixations"
  ADD CONSTRAINT "salary_fixations_marks_within_totals"
  CHECK (
    ("written_test_obtained" IS NULL OR "written_test_total" IS NULL
       OR ("written_test_obtained" >= 0 AND "written_test_obtained" <= "written_test_total")) AND
    ("computer_test_obtained" IS NULL OR "computer_test_total" IS NULL
       OR ("computer_test_obtained" >= 0 AND "computer_test_obtained" <= "computer_test_total")) AND
    ("ai_test_obtained" IS NULL OR "ai_test_total" IS NULL
       OR ("ai_test_obtained" >= 0 AND "ai_test_obtained" <= "ai_test_total"))
  ) NOT VALID;

ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_salary_expectation_non_negative"
  CHECK ("salary_expectation" IS NULL OR "salary_expectation" >= 0) NOT VALID;

-- The AI screening score is defined as a 0-100 match percentage.
ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_match_score_range"
  CHECK ("match_score" IS NULL OR ("match_score" >= 0 AND "match_score" <= 100)) NOT VALID;

-- An auto-graded proficiency attempt cannot score above its own maximum.
ALTER TABLE "ai_proficiency_attempts"
  ADD CONSTRAINT "ai_proficiency_attempts_score_within_max"
  CHECK (
    "max_score" >= 0 AND
    ("total_score" IS NULL OR ("total_score" >= 0 AND "total_score" <= "max_score"))
  ) NOT VALID;

-- Talent-bank relevance is a percentage.
ALTER TABLE "talent_bank_matches"
  ADD CONSTRAINT "talent_bank_matches_relevance_range"
  CHECK ("relevance" >= 0 AND "relevance" <= 100) NOT VALID;

-- Approval chains are ordered from 0 upwards; a negative level would sort
-- ahead of the first real approver and silently become the new step one.
ALTER TABLE "approval_steps"
  ADD CONSTRAINT "approval_steps_order_non_negative"
  CHECK ("order_index" >= 0) NOT VALID;

ALTER TABLE "approval_path_levels"
  ADD CONSTRAINT "approval_path_levels_order_non_negative"
  CHECK ("order_index" >= 0) NOT VALID;

-- A public token that expires before it is issued is already expired; this
-- catches a unit-of-time mistake (seconds vs milliseconds) at the boundary
-- rather than as a stream of "this link has expired" support tickets.
ALTER TABLE "evaluation_tokens"
  ADD CONSTRAINT "evaluation_tokens_expiry_after_creation"
  CHECK ("expires_at" > "created_at") NOT VALID;

-- One global role, held once. The @@unique([role_id, user_id, unit_id]) index
-- cannot enforce this: PostgreSQL treats NULLs as distinct, so a GLOBAL
-- assignment (unit_id IS NULL) can be inserted any number of times for the
-- same person, and revoking it then removes only one of the copies.
CREATE UNIQUE INDEX IF NOT EXISTS "role_assignments_global_unique"
  ON "role_assignments" ("role_id", "user_id")
  WHERE "unit_id" IS NULL;
