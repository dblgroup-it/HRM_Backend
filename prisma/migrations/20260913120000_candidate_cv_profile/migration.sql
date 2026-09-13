-- Structured CV, normalised to one shape whatever produced it (Bdjobs today).
-- Additive and nullable: candidates who only ever had a CV file are untouched.
ALTER TABLE "candidates" ADD COLUMN "cv_profile" JSONB;
ALTER TABLE "candidates" ADD COLUMN "cv_profile_at" TIMESTAMP(3);
