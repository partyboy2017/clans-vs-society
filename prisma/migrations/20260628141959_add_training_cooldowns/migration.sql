/*
  Warnings:

  - The primary key for the `Stats` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `intelligence` on the `Stats` table. All the data in the column will be lost.
  - The `id` column on the `Stats` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `User` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `avatar` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `characterClass` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `googleName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `lastLoginAt` on the `User` table. All the data in the column will be lost.
  - The `id` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `UserSkill` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `UserSkill` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[username]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[email]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `userId` on the `Stats` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `userId` on the `UserSkill` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "Stats" DROP CONSTRAINT "Stats_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserSkill" DROP CONSTRAINT "UserSkill_userId_fkey";

-- DropIndex
DROP INDEX "User_characterName_key";

-- AlterTable
ALTER TABLE "Stats" DROP CONSTRAINT "Stats_pkey",
DROP COLUMN "intelligence",
ADD COLUMN     "lastDefenseTrain" TIMESTAMP(3),
ADD COLUMN     "lastDexTrain" TIMESTAMP(3),
ADD COLUMN     "lastSpeedTrain" TIMESTAMP(3),
ADD COLUMN     "lastStrengthTrain" TIMESTAMP(3),
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "userId",
ADD COLUMN     "userId" INTEGER NOT NULL,
ALTER COLUMN "energy" SET DEFAULT 100,
ALTER COLUMN "maxEnergy" SET DEFAULT 100,
ALTER COLUMN "strength" SET DEFAULT 10,
ALTER COLUMN "defense" SET DEFAULT 10,
ALTER COLUMN "speed" SET DEFAULT 10,
ALTER COLUMN "dexterity" SET DEFAULT 10,
ALTER COLUMN "gold" SET DEFAULT 500,
ADD CONSTRAINT "Stats_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "User" DROP CONSTRAINT "User_pkey",
DROP COLUMN "avatar",
DROP COLUMN "characterClass",
DROP COLUMN "googleName",
DROP COLUMN "lastLoginAt",
ADD COLUMN     "password" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ALTER COLUMN "googleId" DROP NOT NULL,
ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "UserSkill" DROP CONSTRAINT "UserSkill_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "userId",
ADD COLUMN     "userId" INTEGER NOT NULL,
ADD CONSTRAINT "UserSkill_pkey" PRIMARY KEY ("id");

-- CreateTable
CREATE TABLE "House" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "motto" TEXT NOT NULL DEFAULT 'Strength through unity.',
    "gold" INTEGER NOT NULL DEFAULT 0,
    "leaderId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "House_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseMember" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "houseId" INTEGER NOT NULL,
    "rank" TEXT NOT NULL DEFAULT 'Bannerman',

    CONSTRAINT "HouseMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "basePrice" INTEGER NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" SERIAL NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "House_name_key" ON "House"("name");

-- CreateIndex
CREATE UNIQUE INDEX "House_leaderId_key" ON "House"("leaderId");

-- CreateIndex
CREATE UNIQUE INDEX "HouseMember_userId_key" ON "HouseMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Stats_userId_key" ON "Stats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSkill_userId_skillKey_key" ON "UserSkill"("userId", "skillKey");

-- AddForeignKey
ALTER TABLE "Stats" ADD CONSTRAINT "Stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseMember" ADD CONSTRAINT "HouseMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseMember" ADD CONSTRAINT "HouseMember_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
