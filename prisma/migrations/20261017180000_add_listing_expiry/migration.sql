-- Listings now expire after 4 days. Listings that already exist get a fresh
-- 4 days from the time this migration runs, so nothing comes down at once.
ALTER TABLE "Listing" ADD COLUMN "expiresAt" TIMESTAMP(3);
UPDATE "Listing" SET "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '4 days' WHERE "expiresAt" IS NULL;
ALTER TABLE "Listing" ALTER COLUMN "expiresAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Listing_expiresAt_idx" ON "Listing"("expiresAt");
