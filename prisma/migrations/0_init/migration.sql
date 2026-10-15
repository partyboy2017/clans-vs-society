-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT,
    "googleId" TEXT,
    "email" TEXT,
    "googleName" TEXT,
    "avatar" TEXT,
    "characterName" TEXT,
    "characterClass" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stats" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "statPoints" INTEGER NOT NULL DEFAULT 0,
    "strength" INTEGER NOT NULL DEFAULT 0,
    "defense" INTEGER NOT NULL DEFAULT 0,
    "speed" INTEGER NOT NULL DEFAULT 0,
    "dexterity" INTEGER NOT NULL DEFAULT 0,
    "intelligence" INTEGER NOT NULL DEFAULT 0,
    "health" INTEGER NOT NULL DEFAULT 100,
    "maxHealth" INTEGER NOT NULL DEFAULT 100,
    "energy" INTEGER NOT NULL DEFAULT 100,
    "maxEnergy" INTEGER NOT NULL DEFAULT 100,
    "gold" INTEGER NOT NULL DEFAULT 0,
    "hasWagon" BOOLEAN NOT NULL DEFAULT false,
    "wagonTier" INTEGER NOT NULL DEFAULT 0,
    "currentCityId" TEXT,
    "travelDestinationId" TEXT,
    "travelArrivalAt" TIMESTAMP(3),
    "travelDestination" TEXT,
    "travelStartedAt" TIMESTAMP(3),
    "travelArrivesAt" TIMESTAMP(3),
    "lastStrengthTrain" TIMESTAMP(3),
    "lastDefenseTrain" TIMESTAMP(3),
    "lastSpeedTrain" TIMESTAMP(3),
    "lastDexTrain" TIMESTAMP(3),
    "inJail" BOOLEAN NOT NULL DEFAULT false,
    "jailUntil" TIMESTAMP(3),
    "inHospital" BOOLEAN NOT NULL DEFAULT false,
    "hospitalUntil" TIMESTAMP(3),
    "lastEnergyAt" TIMESTAMP(3),
    "lastRaidVillageAt" TIMESTAMP(3),
    "lastRaidCaravanAt" TIMESTAMP(3),
    "lastRaidManorAt" TIMESTAMP(3),
    "lastRaidTreasuryAt" TIMESTAMP(3),

    CONSTRAINT "Stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSkill" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "skillKey" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSkill_pkey" PRIMARY KEY ("id")
);

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
    "icon" TEXT NOT NULL DEFAULT '/assets/items/_fallback/default-item.png',

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

-- CreateTable
CREATE TABLE "CombatSession" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "zoneId" TEXT NOT NULL,
    "monsterName" TEXT NOT NULL,
    "monsterLevel" INTEGER NOT NULL,
    "monsterMaxHealth" INTEGER NOT NULL,
    "monsterHealth" INTEGER NOT NULL,
    "monsterAttack" INTEGER NOT NULL,
    "monsterDefense" INTEGER NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CombatSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_createdAt_idx" ON "ActivityLog"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Stats_userId_key" ON "Stats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSkill_userId_skillKey_key" ON "UserSkill"("userId", "skillKey");

-- CreateIndex
CREATE UNIQUE INDEX "House_name_key" ON "House"("name");

-- CreateIndex
CREATE UNIQUE INDEX "House_leaderId_key" ON "House"("leaderId");

-- CreateIndex
CREATE UNIQUE INDEX "HouseMember_userId_key" ON "HouseMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CombatSession_userId_key" ON "CombatSession"("userId");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "CombatSession" ADD CONSTRAINT "CombatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

