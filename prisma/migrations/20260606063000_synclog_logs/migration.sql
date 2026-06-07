-- Terminal-style log lines for each sync run
ALTER TABLE "sync_logs" ADD COLUMN "logs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
