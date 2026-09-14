-- PLANNED — NOT PART OF THE GO-LIVE RELEASE.
--
-- Salary columns are `double precision`. Binary floating point cannot represent
-- every decimal exactly, so a figure can drift by fractions of a taka through
-- round-trips, comparisons and aggregation. For a number printed on an offer
-- letter that is wrong in principle, even though no wrong figure has yet been
-- observed in this dataset.
--
-- WHY THIS IS NOT IN THE GO-LIVE RELEASE
--
-- The database change is easy. The code change is not: `Prisma.Decimal` is an
-- object, not a number, so every read, comparison, arithmetic operation,
-- serializer, DTO, letter template and frontend display that touches these
-- three columns has to be updated together. Shipping that alongside a security
-- release would mean two hard-to-separate sources of risk in one deployment.
--
-- Classified: READY FOR SCHEDULED DEPLOYMENT.
--
-- ---------------------------------------------------------------------------
-- DATABASE STEP
-- ---------------------------------------------------------------------------
-- numeric(12,2) holds up to 9,999,999,999.99 — far beyond any DBL salary — with
-- exactly two decimal places. The USING clause is explicit: PostgreSQL will not
-- cast double precision to numeric implicitly, and rounding must be stated
-- rather than inherited.
--
-- These are ALTER TYPE on a table with a few rows today, so the rewrite is
-- instant. Re-check `SELECT count(*) FROM salary_fixations;` before assuming
-- that is still true.

ALTER TABLE "salary_fixations"
  ALTER COLUMN "proposed_salary"
    TYPE numeric(12,2) USING round("proposed_salary"::numeric, 2),
  ALTER COLUMN "proposed_salary_override"
    TYPE numeric(12,2) USING round("proposed_salary_override"::numeric, 2);

ALTER TABLE "candidates"
  ALTER COLUMN "salary_expectation"
    TYPE numeric(12,2) USING round("salary_expectation"::numeric, 2);

-- Scores stay `double precision` on purpose: they are averages of marks, not
-- money, and exact decimal representation buys nothing there.

-- ---------------------------------------------------------------------------
-- VERIFY (run after)
-- ---------------------------------------------------------------------------
-- SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
--   FROM information_schema.columns
--  WHERE (table_name = 'salary_fixations'
--         AND column_name IN ('proposed_salary','proposed_salary_override'))
--     OR (table_name = 'candidates' AND column_name = 'salary_expectation');
--   expect: numeric, 12, 2
--
-- Compare a few values against a backup taken immediately before, to confirm
-- the rounding changed nothing that mattered.

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- ALTER TABLE "salary_fixations"
--   ALTER COLUMN "proposed_salary" TYPE double precision USING "proposed_salary"::double precision,
--   ALTER COLUMN "proposed_salary_override" TYPE double precision USING "proposed_salary_override"::double precision;
-- ALTER TABLE "candidates"
--   ALTER COLUMN "salary_expectation" TYPE double precision USING "salary_expectation"::double precision;
--
-- Lossless in practice: every value currently stored came from a double.
