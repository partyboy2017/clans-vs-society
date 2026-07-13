-- AlterTable
ALTER TABLE "Stats" ADD COLUMN     "wagonTier" INTEGER NOT NULL DEFAULT 0;

-- Backfill: anyone who already owns a wagon starts at tier 1 (Basic Wagon).
UPDATE "Stats" SET "wagonTier" = 1 WHERE "hasWagon" = true;
