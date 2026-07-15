-- AlterTable
-- Tracks an in-progress journey to another settlement. travelArrivesAt is the
-- authoritative arrival time — the server, not the client, decides when a
-- journey is actually over.
ALTER TABLE "Stats" ADD COLUMN     "travelDestination" TEXT,
ADD COLUMN     "travelStartedAt" TIMESTAMP(3),
ADD COLUMN     "travelArrivesAt" TIMESTAMP(3);
