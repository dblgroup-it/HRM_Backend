-- System-wide audit log: who did what, when, and to what.
--
-- Two sources feed one table:
--   * 'http'   — every mutating request, captured by an interceptor. Knows the
--                actor and the route even when nothing reached the database.
--   * 'db'     — field-level before/after for the models that matter, captured
--                by a Prisma client extension. Knows what actually changed.
--   * 'system' — scheduled work with no human actor (the nightly ZingHR sync),
--                recorded as one summary row per run rather than per write.
--
-- actor_id is nullable on purpose: public token endpoints (board votes,
-- candidate applications, facility confirmations) have no User row behind them.
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"           TEXT NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_id"     TEXT,
  -- Snapshot — the log must still read correctly if the user is renamed or removed.
  "actor_name"   VARCHAR(150) NOT NULL DEFAULT 'Unknown',
  "actor_type"   VARCHAR(10)  NOT NULL DEFAULT 'user',
  "action"       VARCHAR(60)  NOT NULL,
  "entity"       VARCHAR(60)  NOT NULL,
  "entity_id"    VARCHAR(64),
  "entity_label" VARCHAR(200),
  "summary"      TEXT NOT NULL DEFAULT '',
  -- [{ field, from, to }] — redacted for medical and pay fields.
  "changes"      JSONB,
  "source"       VARCHAR(10)  NOT NULL DEFAULT 'http',
  "method"       VARCHAR(10),
  "path"         VARCHAR(300),
  "status_code"  INTEGER,
  "ip"           VARCHAR(64),
  "request_id"   VARCHAR(40),
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- The list is always "newest first, optionally filtered", so every index leads
-- with something filterable and ends on created_at.
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx"        ON "audit_logs" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_actor_created_idx"     ON "audit_logs" ("actor_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_entity_created_idx"    ON "audit_logs" ("entity", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_entity_id_idx"         ON "audit_logs" ("entity", "entity_id");
CREATE INDEX IF NOT EXISTS "audit_logs_action_created_idx"    ON "audit_logs" ("action", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_request_idx"           ON "audit_logs" ("request_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_actor_id_fkey') THEN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey"
      FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
