-- API errors and slow calls, from the server and from browsers (30 days).
CREATE TABLE "api_logs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" VARCHAR(10) NOT NULL DEFAULT 'api',
    "kind" VARCHAR(10) NOT NULL DEFAULT 'error',
    "method" VARCHAR(10),
    "path" VARCHAR(500),
    "status" INTEGER,
    "duration_ms" INTEGER,
    "user_id" TEXT,
    "user_name" VARCHAR(150),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "request_id" VARCHAR(40),
    "message" TEXT,
    "stack" TEXT,
    CONSTRAINT "api_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "api_logs_created_at_idx" ON "api_logs"("created_at" DESC);
CREATE INDEX "api_logs_status_created_at_idx" ON "api_logs"("status", "created_at" DESC);
CREATE INDEX "api_logs_source_created_at_idx" ON "api_logs"("source", "created_at" DESC);

-- What a sandbox (dev) server would have sent. Empty on the live server.
CREATE TABLE "sandbox_outbox" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" VARCHAR(20) NOT NULL,
    "target" VARCHAR(500),
    "subject" VARCHAR(500),
    "body" TEXT,
    "meta" JSONB,
    CONSTRAINT "sandbox_outbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sandbox_outbox_created_at_idx" ON "sandbox_outbox"("created_at" DESC);
