-- Postal address read off the CV during AI screening. Kept separate from the
-- structured cv_profile (which a source like Bdjobs supplies wholesale) so the
-- provenance of each is obvious: this one is a reading, not a declaration.
ALTER TABLE "candidates" ADD COLUMN "cv_address" VARCHAR(300);
