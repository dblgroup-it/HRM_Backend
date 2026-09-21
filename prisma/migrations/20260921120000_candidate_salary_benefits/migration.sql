-- The benefits a candidate says their current package includes, as ticks
-- rather than prose: lunch, pick and drop, profit share, dormitory, family
-- accommodation, tax paid by the company. Stored as stable keys (see
-- src/modules/assessment/candidate-benefits.ts). The free-text note stays
-- for anything the list does not cover.

ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "salary_benefits" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
