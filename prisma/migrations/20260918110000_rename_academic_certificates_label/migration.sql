-- "Academic Certificates" becomes "Academic Certificates / Marksheet".
--
-- The marksheet was briefly a separate optional item; it belongs with the
-- certificates, since a candidate hands both over together.
--
-- This rename is not cosmetic. An uploaded document is matched to its checklist
-- row by an exact label string, so renaming the checklist entry alone would
-- leave every document already uploaded under the old name unmatched: the
-- candidate's page would show the row empty, progress would drop, and someone
-- would be asked to upload a certificate they had already sent.
--
-- Idempotent — a second run matches nothing.
UPDATE "onboarding_docs"
   SET "label" = 'Academic Certificates / Marksheet'
 WHERE "label" = 'Academic Certificates';
