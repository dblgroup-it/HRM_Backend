-- Repair Factory HR layering and job analyses left with former Factory HR.
-- Idempotent: running it again changes nothing.

-- 1. Number every unit's Factory HR holders 1..n with no gaps, keeping the
--    existing order and putting unordered holders last by when they were
--    added. A unit whose first priority was moved elsewhere showed 2 and 3;
--    it now shows 1 and 2. From here on the API keeps it that way.
WITH ranked AS (
  SELECT ra.id,
         row_number() OVER (
           PARTITION BY ra.unit_id
           ORDER BY ra.priority NULLS LAST, ra.created_at
         ) AS rn
    FROM role_assignments ra
    JOIN roles r ON r.id = ra.role_id
   WHERE r.key = 'factory_hr'
     AND ra.unit_id IS NOT NULL
)
UPDATE role_assignments ra
   SET priority = ranked.rn
  FROM ranked
 WHERE ra.id = ranked.id
   AND ra.priority IS DISTINCT FROM ranked.rn;

-- 2. A job analysis addressed by name to someone who no longer holds Factory
--    HR for that unit goes back to the unit's queue. It kept showing on that
--    person's dashboard after they were moved (e.g. to Factory HR Head).
--    Unit names are compared the way the app compares them: trimmed, case
--    folded, trailing punctuation dropped.
UPDATE requisitions q
   SET job_analysis_assignee_id = NULL
 WHERE q.status = 'PENDING_JOB_ANALYSIS'
   AND q.job_analysis_assignee_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM role_assignments ra
       JOIN roles r ON r.id = ra.role_id
       LEFT JOIN units u ON u.id = ra.unit_id
      WHERE ra.user_id = q.job_analysis_assignee_id
        AND r.key = 'factory_hr'
        AND (
          ra.unit_id IS NULL
          OR lower(regexp_replace(trim(u.name), '[.,;:''`-]+$', ''))
           = lower(regexp_replace(trim(q.unit_factory), '[.,;:''`-]+$', ''))
        )
   );
