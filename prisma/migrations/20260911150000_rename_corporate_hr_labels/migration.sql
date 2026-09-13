-- Carry the Head of Talent Acquisition rename into stored display text.
--
-- Two kinds of row, both display-only:
--   * approval_steps.title — the label of a chain step, including steps already
--     snapshotted onto in-flight requisitions. Renaming the label does not
--     change who signed or what they decided; leaving it would show the old
--     name on every requisition currently in flight.
--   * notifications — the bell list. Past wording, but it is UI text, not a
--     record of record.
--
-- Scoped by role/type so the DEPARTMENT called "Corporate HR" — 35 employees,
-- 2 requisitions and a master_options row — is not caught by this.
UPDATE "approval_steps"
SET "title" = REPLACE("title", 'Corporate HR', 'Head of Talent Acquisition')
WHERE "role" = 'CORPORATE_HR' AND "title" LIKE '%Corporate HR%';

UPDATE "notifications"
SET "title"   = REPLACE("title",   'Corporate HR', 'Head of Talent Acquisition'),
    "message" = REPLACE("message", 'Corporate HR', 'Head of Talent Acquisition')
WHERE "title" LIKE '%Corporate HR%' OR "message" LIKE '%Corporate HR%';
