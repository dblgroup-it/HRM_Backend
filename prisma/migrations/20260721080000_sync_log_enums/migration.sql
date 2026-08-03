-- Convert sync_logs.source and sync_logs.status from VARCHAR to typed enums.

CREATE TYPE "SyncSource" AS ENUM ('zinghr');
CREATE TYPE "SyncStatus" AS ENUM ('running', 'success', 'failed');

-- Drop defaults before type change, then restore them as enum literals.
ALTER TABLE "sync_logs" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "sync_logs" ALTER COLUMN "source" TYPE "SyncSource" USING "source"::"SyncSource";
ALTER TABLE "sync_logs" ALTER COLUMN "source" SET DEFAULT 'zinghr'::"SyncSource";

ALTER TABLE "sync_logs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "sync_logs" ALTER COLUMN "status" TYPE "SyncStatus" USING "status"::"SyncStatus";
ALTER TABLE "sync_logs" ALTER COLUMN "status" SET DEFAULT 'running'::"SyncStatus";
