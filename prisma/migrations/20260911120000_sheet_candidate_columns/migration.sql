-- The three sheet columns the system doesn't hold as structured data:
-- the candidate's own education, total experience and last employer.
--
-- Pre-filled from the CV screening extract, then correctable by Corporate HR
-- before the sheet goes out — an AI reading of a CV is a starting point, not
-- something to put in front of the board unchecked. Stored per approval so a
-- correction sticks with that candidate's row.
ALTER TABLE "board_approvals"
  ADD COLUMN IF NOT EXISTS "sheet_education"  TEXT,
  ADD COLUMN IF NOT EXISTS "sheet_experience" VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "sheet_last_org"   VARCHAR(200);
