# Release Migrations — review for production

Four migrations ship with this release. All three are **additive**: no `DROP
TABLE`, no `DROP COLUMN`, no `DELETE`, no `TRUNCATE`, no `UPDATE`, and no
`ALTER COLUMN … TYPE`. Verified by scanning the SQL, not by assertion.

They apply in filename order, which `prisma migrate deploy` follows:

```
1. 20260913220000_integrity_check_constraints
2. 20260913230000_first_login_and_lockout
3. 20260914090000_hash_public_action_tokens
4. 20260914120000_delegation_send_tracking
```

**Status: applied and verified on the DEVELOPMENT database only.** Nothing in
this file has been run against production.

---

## 1. `20260913220000_integrity_check_constraints`

**Purpose.** The database had **zero** CHECK constraints. Every invariant —
`filled <= sanctioned`, non-negative pay, a mark not exceeding its own paper
total, a 0–100 match score — lived only in TypeScript, so a script, a console
session or a future endpoint could write any of them.

**Affected tables.** `positions` (3), `requisitions` (2), `salary_fixations`
(2), `candidates` (2), `ai_proficiency_attempts`, `talent_bank_matches`,
`approval_steps`, `approval_path_levels`, `evaluation_tokens` — 14 CHECK
constraints — plus one partial unique index on `role_assignments`.

**Lock level.**

| Statement | Lock | Duration |
| --- | --- | --- |
| `ALTER TABLE … ADD CONSTRAINT … CHECK … NOT VALID` × 14 | `ACCESS EXCLUSIVE`, catalogue only | Milliseconds — `NOT VALID` means **no table scan** |
| `CREATE UNIQUE INDEX … ON role_assignments` | `SHARE` (blocks writes to that table) | Milliseconds at current size |

The `NOT VALID` choice is the whole point: the constraint binds every future
INSERT and UPDATE immediately, but existing rows are not read, so the migration
cannot fail on legacy data and cannot hold a long lock.

**Rollback compatibility.** Fully compatible. The previous code never wrote
values that violate these rules — proven by validating all 14 against the full
development dataset with zero failures. A code rollback needs no database
change. To remove them anyway:

```sql
ALTER TABLE <table> DROP CONSTRAINT <constraint>;   -- per constraint
DROP INDEX role_assignments_global_unique;
```

**Pre-check required — YES, and this is the only hard blocker in the release.**

`role_assignments_global_unique` is a real unique index; an index cannot be
created `NOT VALID`, so duplicate data aborts it **part-way through the
release**. `PRODUCTION_DB_PRECHECK.sql` §2 answers this:

```sql
SELECT role_id, user_id, count(*) FROM role_assignments
 WHERE unit_id IS NULL GROUP BY 1,2 HAVING count(*) > 1;
```

Zero rows → proceed. Otherwise delete the duplicates first (the pre-check prints
which id to keep). The existing `@@unique([roleId,userId,unitId])` never caught
these because PostgreSQL treats NULLs as distinct.

**Post-deploy validation required — YES.** During a quiet period, validate each
constraint against existing rows. A failure names the offending row and changes
nothing:

```sql
ALTER TABLE positions              VALIDATE CONSTRAINT positions_filled_within_sanctioned;
ALTER TABLE positions              VALIDATE CONSTRAINT positions_sanctioned_non_negative;
ALTER TABLE positions              VALIDATE CONSTRAINT positions_filled_non_negative;
ALTER TABLE requisitions           VALIDATE CONSTRAINT requisitions_required_posts_positive;
ALTER TABLE requisitions           VALIDATE CONSTRAINT requisitions_total_vacant_non_negative;
ALTER TABLE salary_fixations       VALIDATE CONSTRAINT salary_fixations_amounts_non_negative;
ALTER TABLE salary_fixations       VALIDATE CONSTRAINT salary_fixations_marks_within_totals;
ALTER TABLE candidates             VALIDATE CONSTRAINT candidates_salary_expectation_non_negative;
ALTER TABLE candidates             VALIDATE CONSTRAINT candidates_match_score_range;
ALTER TABLE ai_proficiency_attempts VALIDATE CONSTRAINT ai_proficiency_attempts_score_within_max;
ALTER TABLE talent_bank_matches    VALIDATE CONSTRAINT talent_bank_matches_relevance_range;
ALTER TABLE approval_steps         VALIDATE CONSTRAINT approval_steps_order_non_negative;
ALTER TABLE approval_path_levels   VALIDATE CONSTRAINT approval_path_levels_order_non_negative;
ALTER TABLE evaluation_tokens      VALIDATE CONSTRAINT evaluation_tokens_expiry_after_creation;
```

`VALIDATE` takes only a `SHARE UPDATE EXCLUSIVE` lock — reads and writes
continue — but it does scan the table, so run them one at a time.

---

## 2. `20260913230000_first_login_and_lockout`

**Purpose.** Support a forced first-login password change and account-level
lockout. A synced employee's default password **is their employee code**, which
is printed in the directory every signed-in user can read; per-IP throttling
alone does not protect an account from a distributed guesser.

**Affected tables.** `users` — three columns, plus one partial index.

| Column | Type | Default |
| --- | --- | --- |
| `must_change_password` | `BOOLEAN NOT NULL` | `false` |
| `failed_login_attempts` | `INTEGER NOT NULL` | `0` |
| `locked_until` | `TIMESTAMP(3)` | `NULL` |

**Lock level.** `ACCESS EXCLUSIVE`, but **metadata only**. PostgreSQL 11+ adds a
`NOT NULL` column with a constant default without rewriting the table, so this
is milliseconds even on the 4,614-row `users` table. The partial index is
`WHERE locked_until IS NOT NULL`, so it indexes almost nothing.

**Rollback compatibility.** Fully compatible, and deliberately so. **Every
default reproduces the previous behaviour exactly**: nobody starts locked, nobody
starts part-way to a lock, and nobody is forced to change a password. Old code
ignores the columns entirely.

**Pre-check required — no.** The migration cannot fail.

**Post-deploy validation required — no**, but note what the migration
deliberately does *not* do: it sets `must_change_password = false` for everyone.
Turning it on for existing accounts is a **separate business decision** with its
own reviewed SQL (see `FINAL_GO_LIVE_GATE.md` §7c). Deciding when to disrupt
~4,600 people is not a deployment's call. Admin password resets set the flag
automatically from this release onward.

---

## 3. `20260914090000_hash_public_action_tokens`

**Purpose.** Stage 1 of 2 — store public action tokens as a SHA-256 hash. These
tokens stand in for a login on a public page (an evaluation link, a candidate's
onboarding page, a board vote, a facility confirmation, a proficiency test).
Stored raw, read access to the database was enough to cast a board member's vote
or open a candidate's onboarding record.

**Affected tables.** `evaluation_tokens`, `onboardings`,
`ai_proficiency_attempts`, `board_approval_votes`, `facility_notifications` —
each gets a nullable, unique `token_hash`, and each has its existing `token`
column made **nullable**.

**Lock level.** `ACCESS EXCLUSIVE`, catalogue only. `ALTER COLUMN … DROP NOT
NULL` is a catalogue flag change — **not** a rewrite, and **not** `ALTER COLUMN
… TYPE`. Adding a nullable column with no default is likewise metadata only. The
five unique indexes are built on tables of tens of rows. Milliseconds.

**Rollback compatibility — the one caveat in this release.**

The migration itself is safe to leave in place: `token_hash` is nullable and old
code ignores it; `token` being nullable does not disturb code that only reads it.

**But**: board-vote and facility tokens issued *after* this release are stored
hashed-only, with `token = NULL`. If you roll the **code** back while keeping the
migration, the old code looks up the raw column and **those links stop working**.
Nothing else is affected, and re-sending issues fresh links. Links issued before
the release are unaffected either way.

**Pre-check required — no.** `token` is not cleared and no row is modified, so
**no link already sitting in somebody's inbox breaks.** Lookups are dual-read:
hash first, falling back to the raw column only where no hash is recorded. A
legacy row is upgraded in place the first time it is used.

**Post-deploy validation required — monitoring rather than validation.**
`PRODUCTION_DB_PRECHECK.sql` §7 reports `hashed` / `still_raw` / `live_now` per
table. Watch `still_raw` fall. **Stage 2 (dropping the `token` columns) must not
run until it reaches zero** — and onboarding tokens never expire, so that residue
needs an explicit sweep first.

Transition window, being the longest a legacy link can remain valid:

| Table | Expiry |
| --- | --- |
| `evaluation_tokens` | 48h after the interview, or 7 days |
| `board_approval_votes` | `token_expires_at` — 30 days on sheet sends |
| `facility_notifications` | `token_expires_at` — 14 days |
| `ai_proficiency_attempts` | no expiry; bounded by submission |
| `onboardings` | **no expiry** — the long pole |

---

## 4. `20260914120000_delegation_send_tracking`

**Purpose.** Record re-sends of an interview delegation. Rows are upserted, so
handing the same candidate to the same interviewer again silently overwrote the
note and left `created_at` at the original hand-off — Corporate HR could chase
the same person three times with no record that they had, and no way to tell a
fresh assignment from one that had been sitting for a fortnight.

**Affected tables.** `interview_delegations` — two columns and one partial index.

| Column | Type | Default |
| --- | --- | --- |
| `send_count` | `INTEGER NOT NULL` | `1` |
| `last_sent_at` | `TIMESTAMP(3) NOT NULL` | `CURRENT_TIMESTAMP` |

**Lock level.** `ACCESS EXCLUSIVE`, metadata only — PostgreSQL 11+ adds a
`NOT NULL` column with a constant default without rewriting. Followed by one
`UPDATE` over the table to set `last_sent_at = created_at`; at 12 rows today
that is instant. **Check the row count before assuming that stays true:**
`SELECT count(*) FROM interview_delegations;` — beyond a few hundred thousand
it would want batching.

**Rollback compatibility.** Fully compatible. Both defaults reproduce the
previous behaviour: every existing delegation was sent exactly once, and
`created_at` is when. Old code ignores both columns.

**Pre-check required — no.** The migration cannot fail.

**Post-deploy validation required — no.** Optionally confirm the backfill:

```sql
SELECT count(*) FILTER (WHERE last_sent_at <> created_at) AS should_be_zero
  FROM interview_delegations;
```

Zero immediately after deploy; it grows as people are chased, which is the
point.

---

## Deliberately excluded from this release

| Change | Where it lives | Why it is out |
| --- | --- | --- |
| Salary `Float` → `Decimal(12,2)` | `HRM_Backend/prisma/planned/salary_decimal/` | **Verified absent from `prisma/migrations/`**, so `prisma migrate deploy` cannot pick it up. `Prisma.Decimal` is an object, not a number, so it ripples through every salary read, comparison, letter, export and frontend display. That risk must not ride along with a security release. Classified **READY FOR SCHEDULED DEPLOYMENT**; SQL written with explicit `USING` clauses, code changes enumerated in `CODE_CHANGES.md`. |
| `timestamp` → `timestamptz` | not written | **Verified absent.** Prisma is self-consistent (UTC in, UTC out); only raw SQL is affected. Needs `SET timezone='UTC'` and its own window. |
| Dropping the raw `token` columns (stage 2) | not written | Must wait for the transition window above. |
| `UNIQUE` on `users.email` | not written | Five duplicate clusters exist in the data; they must be resolved first. |

---

## Summary

| Migration | Destructive? | Can fail? | Rollback-safe? | Pre-check | Post-deploy |
| --- | --- | --- | --- | --- | --- |
| `integrity_check_constraints` | no | **yes — the unique index** | yes | **required** | 14 × `VALIDATE` |
| `first_login_and_lockout` | no | no | yes | no | none |
| `hash_public_action_tokens` | no | no | yes, with one caveat | no | monitor §7 |
| `delegation_send_tracking` | no | no | yes | no | none |

**Verified on development only. Production application has not been attempted.**
