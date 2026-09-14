-- Redact pay figures already written into audit_logs.
--
-- AuditService now keeps salary out of the log, but rows written before that
-- still hold the figures — a second, less-protected copy of what people are
-- paid, readable by anyone who can open the activity log.
--
-- This REDACTS IN PLACE. It does not delete audit records: the entry, its
-- actor, its timestamp and the fact that the field changed are all preserved,
-- which is the whole point of an audit log. Only the values are replaced with
-- '[redacted]', exactly as the application would write them today.
--
--   psql "<DATABASE_URL without the ?query>" -f scripts/redact-audit-pay-values.sql
--
-- TAKE A BACKUP FIRST — this is the only script in the release that modifies
-- existing rows:
--   ./scripts/backup-production.sh
--
-- Idempotent: re-running it changes nothing, because rows already showing
-- '[redacted]' no longer match.

BEGIN;

-- What is about to change. Review this before committing.
SELECT count(*) AS rows_to_redact
  FROM audit_logs a
 WHERE jsonb_typeof(a.changes) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(a.changes) c
      WHERE c->>'field' IN ('proposedSalary','proposedSalaryOverride','salaryExpectation',
                            'averageScore','computedBand','bandOverride',
                            'writtenTestObtained','writtenTestTotal',
                            'computerTestObtained','computerTestTotal',
                            'aiTestObtained','aiTestTotal','totalScore')
        AND c->>'to' IS DISTINCT FROM '[redacted]'
   );

UPDATE audit_logs a
   SET changes = rebuilt.changes
  FROM (
    SELECT a2.id,
           jsonb_agg(
             CASE
               WHEN c->>'field' IN ('proposedSalary','proposedSalaryOverride','salaryExpectation',
                                    'averageScore','computedBand','bandOverride',
                                    'writtenTestObtained','writtenTestTotal',
                                    'computerTestObtained','computerTestTotal',
                                    'aiTestObtained','aiTestTotal','totalScore')
               -- Field name and the fact of the change are kept; only the
               -- before/after values go.
               THEN jsonb_build_object('field', c->>'field',
                                       'from', '[redacted]',
                                       'to',   '[redacted]')
               ELSE c
             END
             ORDER BY ord
           ) AS changes
      FROM audit_logs a2,
           LATERAL jsonb_array_elements(a2.changes) WITH ORDINALITY AS t(c, ord)
     WHERE jsonb_typeof(a2.changes) = 'array'
     GROUP BY a2.id
  ) AS rebuilt
 WHERE a.id = rebuilt.id
   AND a.changes IS DISTINCT FROM rebuilt.changes;

-- Must return 0.
SELECT count(*) AS remaining_unredacted
  FROM audit_logs a
 WHERE jsonb_typeof(a.changes) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(a.changes) c
      WHERE c->>'field' IN ('proposedSalary','proposedSalaryOverride','salaryExpectation',
                            'averageScore','computedBand','bandOverride',
                            'writtenTestObtained','writtenTestTotal',
                            'computerTestObtained','computerTestTotal',
                            'aiTestObtained','aiTestTotal','totalScore')
        AND c->>'to' IS DISTINCT FROM '[redacted]'
   );

-- Inspect the two counts above, then:
COMMIT;
-- ...or ROLLBACK; if anything looks wrong.
