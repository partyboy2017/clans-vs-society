-- AlterTable
ALTER TABLE "Stats" ADD COLUMN     "intelligence" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatar" TEXT,
ADD COLUMN     "characterClass" TEXT,
ADD COLUMN     "googleName" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3);
