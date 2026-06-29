/*
  Warnings:

  - The `characterClass` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatar" TEXT,
ADD COLUMN     "googleName" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
DROP COLUMN "characterClass",
ADD COLUMN     "characterClass" TEXT;

-- DropEnum
DROP TYPE "CharacterClass";
