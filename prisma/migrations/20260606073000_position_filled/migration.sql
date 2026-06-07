-- Manually-maintained filled count per seat (vacant = sanctioned - filled)
ALTER TABLE "positions" ADD COLUMN "filled" INTEGER NOT NULL DEFAULT 0;
