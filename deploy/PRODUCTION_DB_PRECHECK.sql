-- ===========================================================================
-- DBL HRM — production database pre-flight check
--
-- READ-ONLY. Every statement is a SELECT. There is no INSERT, UPDATE, DELETE,
-- ALTER, DROP or TRUNCATE in this file, by design — run it against production
-- with confidence, before deploying.
--
--   psql "<DATABASE_URL without the ?query>" -f PRODUCTION_DB_PRECHECK.sql
--
-- HOW TO READ IT
--   Every section returns a `verdict` column.
--     OK      nothing to do
--     WARN    look at it; usually not a blocker
--     BLOCK   fix before deploying — the deployment will fail or do harm
--
-- The one hard blocker is section 2: the migration creating a partial unique
-- index on role_assignments cannot be added NOT VALID, so a duplicate row
-- there will abort `prisma migrate deploy` part-way through the release.
-- ===========================================================================

\echo '=== 1. Environment ==================================================='
SELECT current_database()                    AS database,
       current_setting('server_version')     AS postgres_version,
       current_setting('TimeZone')           AS server_timezone,
       current_user                          AS connected_as,
       (SELECT count(*) FROM pg_stat_activity) AS active_connections;

\echo ''
\echo '=== 2. BLOCKER: duplicate GLOBAL role assignments ===================='
-- The token-hashing and integrity migrations are additive and safe. This one
-- is not: `role_assignments_global_unique` is a real unique index, so it fails
-- on duplicate data. @@unique([roleId,userId,unitId]) never caught these
-- because PostgreSQL treats NULLs as distinct.
SELECT CASE WHEN count(*) = 0
            THEN 'OK — no duplicates; the migration will apply cleanly'
            ELSE 'BLOCK — delete the duplicate rows listed below first'
       END AS verdict,
       count(*) AS duplicate_groups
FROM (
  SELECT role_id, user_id
  FROM role_assignments
  WHERE unit_id IS NULL
  GROUP BY role_id, user_id
  HAVING count(*) > 1
) d;

-- The offending rows, if any. Ids only — no names.
SELECT ra.role_id, ra.user_id, count(*) AS copies,
       min(ra.id) AS keep_this_id,
       string_agg(ra.id, ', ' ORDER BY ra.created_at DESC) AS all_ids
FROM role_assignments ra
WHERE ra.unit_id IS NULL
GROUP BY ra.role_id, ra.user_id
HAVING count(*) > 1;

\echo ''
\echo '=== 3. Duplicate sign-in emails ====================================='
-- users.email has no unique constraint and login used to resolve a shared
-- address arbitrarily. The code now refuses an ambiguous email and tells the
-- user to sign in with their employee code, so this is no longer a blocker —
-- but each cluster is a person who cannot use their email to sign in.
SELECT CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN — these users must sign in with their employee code' END AS verdict,
       count(*) AS duplicate_email_clusters
FROM (
  SELECT lower(email) FROM users
  WHERE email IS NOT NULL AND email <> ''
  GROUP BY 1 HAVING count(*) > 1
) d;

-- Masked, so the file can be pasted into a ticket.
SELECT left(u.email, 2) || '***@' || split_part(u.email, '@', 2) AS masked_email,
       count(*) AS accounts,
       sum(CASE WHEN u.status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
       sum(CASE WHEN u.role = 'ADMIN'
                  OR EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.user_id = u.id)
                THEN 1 ELSE 0 END) AS can_sign_in
FROM users u
JOIN (
  SELECT lower(email) AS e FROM users
  WHERE email IS NOT NULL AND email <> ''
  GROUP BY 1 HAVING count(*) > 1
) d ON lower(u.email) = d.e
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== 4. Data that would violate the CHECK constraints ================='
-- The constraints are added NOT VALID, so the migration cannot fail on
-- existing rows. Anything found here would block the later VALIDATE step and
-- represents a state the application believes is impossible.
SELECT 'positions: filled > sanctioned'        AS rule, count(*) AS offending_rows,
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END AS verdict
  FROM positions WHERE filled > sanctioned
UNION ALL SELECT 'positions: negative sanctioned', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM positions WHERE sanctioned < 0
UNION ALL SELECT 'positions: negative filled', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM positions WHERE filled < 0
UNION ALL SELECT 'requisitions: required_posts <= 0', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM requisitions WHERE required_posts <= 0
UNION ALL SELECT 'requisitions: negative vacancies', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM requisitions WHERE total_vacant_posts < 0
UNION ALL SELECT 'salary: negative proposed', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM salary_fixations WHERE proposed_salary < 0
UNION ALL SELECT 'salary: negative override', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM salary_fixations WHERE proposed_salary_override < 0
UNION ALL SELECT 'salary: written mark above total', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM salary_fixations WHERE written_test_obtained > written_test_total
UNION ALL SELECT 'salary: computer mark above total', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM salary_fixations WHERE computer_test_obtained > computer_test_total
UNION ALL SELECT 'salary: AI mark above total', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM salary_fixations WHERE ai_test_obtained > ai_test_total
UNION ALL SELECT 'candidates: negative salary expectation', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM candidates WHERE salary_expectation < 0
UNION ALL SELECT 'candidates: match score outside 0-100', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM candidates WHERE match_score < 0 OR match_score > 100
UNION ALL SELECT 'attempts: score above maximum', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM ai_proficiency_attempts WHERE total_score > max_score
UNION ALL SELECT 'talent matches: relevance outside 0-100', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM talent_bank_matches WHERE relevance < 0 OR relevance > 100
UNION ALL SELECT 'approval steps: negative order_index', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM approval_steps WHERE order_index < 0
UNION ALL SELECT 'path levels: negative order_index', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM approval_path_levels WHERE order_index < 0
UNION ALL SELECT 'eval tokens: expiry before creation', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END FROM evaluation_tokens WHERE expires_at <= created_at
ORDER BY 3 DESC, 1;

\echo ''
\echo '=== 5. Orphaned records in the compliance-critical chain ============'
-- Every one of these relations is enforced by a foreign key, so a non-zero
-- count means something has gone very wrong. Cheap to check, alarming to miss.
SELECT 'candidates without a requisition' AS relation, count(*) AS orphans,
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCK' END AS verdict
  FROM candidates c LEFT JOIN requisitions r ON r.id = c.requisition_id WHERE r.id IS NULL
UNION ALL SELECT 'onboardings without a candidate', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCK' END
  FROM onboardings o LEFT JOIN candidates c ON c.id = o.candidate_id WHERE c.id IS NULL
UNION ALL SELECT 'medical exams without an onboarding', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCK' END
  FROM medical_exams m LEFT JOIN onboardings o ON o.id = m.onboarding_id WHERE o.id IS NULL
UNION ALL SELECT 'board approvals without a candidate', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCK' END
  FROM board_approvals b LEFT JOIN candidates c ON c.id = b.candidate_id WHERE c.id IS NULL
UNION ALL SELECT 'approval steps without a requisition', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCK' END
  FROM approval_steps s LEFT JOIN requisitions r ON r.id = s.requisition_id WHERE r.id IS NULL
UNION ALL SELECT 'evaluations without a round', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCK' END
  FROM evaluations e LEFT JOIN interview_rounds ir ON ir.id = e.round_id WHERE ir.id IS NULL
UNION ALL SELECT 'salary fixations without a candidate', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCK' END
  FROM salary_fixations sf LEFT JOIN candidates c ON c.id = sf.candidate_id WHERE c.id IS NULL
ORDER BY 3 DESC, 1;

\echo ''
\echo '=== 6. Impossible workflow states ==================================='
SELECT 'requisition APPROVED with a rejected step' AS state, count(*) AS rows,
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END AS verdict
  FROM requisitions r
 WHERE r.status = 'APPROVED'
   AND EXISTS (SELECT 1 FROM approval_steps s WHERE s.requisition_id = r.id AND s.status = 'REJECTED')
UNION ALL SELECT 'requisition REJECTED but every step approved', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END
  FROM requisitions r
 WHERE r.status = 'REJECTED'
   AND NOT EXISTS (SELECT 1 FROM approval_steps s WHERE s.requisition_id = r.id AND s.status <> 'APPROVED')
   AND EXISTS (SELECT 1 FROM approval_steps s WHERE s.requisition_id = r.id)
UNION ALL SELECT 'onboarding cleared medically with no clearer recorded', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END
  FROM onboardings WHERE medical_status = 'cleared' AND medical_cleared_by_id IS NULL
UNION ALL SELECT 'board approval approved but still pending a stage', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END
  FROM board_approvals WHERE status = 'approved' AND current_stage <> 'board'
UNION ALL SELECT 'salary finalised with no proposed amount', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END
  FROM salary_fixations
 WHERE status = 'fixed' AND proposed_salary IS NULL AND proposed_salary_override IS NULL
UNION ALL SELECT 'duplicate approval order_index on one requisition', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCK' END
  FROM (SELECT requisition_id, order_index FROM approval_steps
        GROUP BY 1,2 HAVING count(*) > 1) d
ORDER BY 3 DESC, 1;

\echo ''
\echo '=== 7. Public action tokens ========================================='
-- After the hashing migration, board-vote and facility tokens should stop
-- accumulating raw values. Legacy rows are migrated as they are used; this is
-- how you watch the residue drain before dropping the raw columns.
SELECT 'board_approval_votes'    AS token_table,
       count(*) AS total,
       count(*) FILTER (WHERE token_hash IS NOT NULL) AS hashed,
       count(*) FILTER (WHERE token IS NOT NULL)      AS still_raw,
       count(*) FILTER (WHERE status = 'pending' AND token_expires_at > now()) AS live_now
  FROM board_approval_votes
UNION ALL SELECT 'facility_notifications', count(*),
       count(*) FILTER (WHERE token_hash IS NOT NULL),
       count(*) FILTER (WHERE token IS NOT NULL),
       count(*) FILTER (WHERE confirmed_at IS NULL AND token_expires_at > now())
  FROM facility_notifications
UNION ALL SELECT 'evaluation_tokens', count(*),
       count(*) FILTER (WHERE token_hash IS NOT NULL),
       count(*) FILTER (WHERE token IS NOT NULL),
       count(*) FILTER (WHERE status <> 'submitted' AND expires_at > now())
  FROM evaluation_tokens
UNION ALL SELECT 'onboardings', count(*),
       count(*) FILTER (WHERE token_hash IS NOT NULL),
       count(*) FILTER (WHERE token IS NOT NULL),
       count(*) FILTER (WHERE archived_at IS NULL)
  FROM onboardings
UNION ALL SELECT 'ai_proficiency_attempts', count(*),
       count(*) FILTER (WHERE token_hash IS NOT NULL),
       count(*) FILTER (WHERE token IS NOT NULL),
       count(*) FILTER (WHERE status = 'pending')
  FROM ai_proficiency_attempts
ORDER BY 1;

\echo ''
\echo '=== 8. Stale live tokens ============================================'
-- Onboarding links never expire. A link issued long ago and never used is a
-- credential still sitting in somebody'"'"'s inbox.
SELECT 'onboarding links older than 180 days, not archived' AS finding,
       count(*) AS rows,
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN — consider archiving these' END AS verdict
  FROM onboardings
 WHERE archived_at IS NULL AND created_at < now() - interval '180 days'
UNION ALL SELECT 'board votes pending past their expiry', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END
  FROM board_approval_votes WHERE status = 'pending' AND token_expires_at < now()
UNION ALL SELECT 'facility notifications unconfirmed past expiry', count(*),
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'WARN' END
  FROM facility_notifications WHERE confirmed_at IS NULL AND token_expires_at < now();

\echo ''
\echo '=== 9. Documents still published on Google Drive ===================='
-- Counts of objects the revoke sweep will look at. It cannot be answered from
-- SQL alone (Drive holds the permission), so run the sweep in dry-run mode:
--   npx ts-node scripts/revoke-public-drive-access.ts
SELECT 'candidate CVs'            AS document_class, count(*) AS drive_objects FROM candidates WHERE cv_file_id IS NOT NULL
UNION ALL SELECT 'onboarding documents', count(*) FROM onboarding_docs
UNION ALL SELECT '  of which medical', count(*) FROM onboarding_docs WHERE label ~* 'medical|health|fitness'
UNION ALL SELECT 'board attachments', count(*) FROM board_approvals WHERE hr_approval_attachment_file_id IS NOT NULL
UNION ALL SELECT 'archived joining folders', count(*) FROM onboardings WHERE archive_folder_url IS NOT NULL
ORDER BY 2 DESC;

\echo ''
\echo '=== 10. Audit log: salary values recorded before redaction =========='
-- Redaction is fixed going forward. Rows written earlier still hold figures.
-- REMEDIATE.sql redacts them in place; it is a separate, reviewed file.
-- `changes` is JSON null on some rows, and jsonb_array_elements rejects a
-- scalar — so the type is checked before the lateral expands anything.
SELECT CASE WHEN count(*) = 0 THEN 'OK — nothing to redact'
            ELSE 'WARN — run the redaction script in FINAL_GO_LIVE_GATE.md' END AS verdict,
       count(*) AS audit_rows_with_pay_values
  FROM (
    SELECT a.id, c
      FROM audit_logs a,
           LATERAL jsonb_array_elements(a.changes) c
     WHERE jsonb_typeof(a.changes) = 'array'
  ) x
 WHERE x.c->>'field' IN ('proposedSalary','proposedSalaryOverride','salaryExpectation',
                         'averageScore','computedBand','bandOverride',
                         'writtenTestObtained','computerTestObtained','aiTestObtained')
   AND x.c->>'to' IS DISTINCT FROM '[redacted]';

\echo ''
\echo '=== 11. Accounts still on a provisioned password ===================='
-- must_change_password is NOT set by the migration (it defaults false), so
-- this reports zero until an operator runs the reviewed rollout statement.
SELECT count(*) FILTER (WHERE must_change_password) AS must_change,
       count(*) FILTER (WHERE locked_until > now()) AS currently_locked,
       count(*) FILTER (WHERE two_factor_enabled)   AS two_factor_enabled,
       count(*) AS total_users
  FROM users;

\echo ''
\echo '=== 12. Migration state ============================================='
SELECT migration_name,
       CASE WHEN finished_at IS NOT NULL THEN 'applied'
            WHEN rolled_back_at IS NOT NULL THEN 'ROLLED BACK'
            ELSE 'INCOMPLETE — investigate before deploying' END AS state,
       finished_at
  FROM _prisma_migrations
 ORDER BY started_at DESC
 LIMIT 10;

\echo ''
\echo '=== Pre-flight complete ============================================='
\echo 'Any BLOCK above must be resolved before `prisma migrate deploy`.'
