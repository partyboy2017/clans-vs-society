-- AlterTable
-- currentCityId is nullable: NULL means the player is in Aurelia (home/capital).
ALTER TABLE "Stats" ADD COLUMN     "currentCityId" TEXT;
