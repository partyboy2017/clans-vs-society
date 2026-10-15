-- AlterTable
ALTER TABLE "Stats" ADD COLUMN     "hospitalUntil" TIMESTAMP(3),
ADD COLUMN     "inHospital" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inJail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "jailUntil" TIMESTAMP(3);
