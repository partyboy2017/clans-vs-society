-- CreateTable
CREATE TABLE "HouseJoinRequest" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "houseId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HouseJoinRequest_userId_key" ON "HouseJoinRequest"("userId");

-- CreateIndex
CREATE INDEX "HouseJoinRequest_houseId_idx" ON "HouseJoinRequest"("houseId");

-- AddForeignKey
ALTER TABLE "HouseJoinRequest" ADD CONSTRAINT "HouseJoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseJoinRequest" ADD CONSTRAINT "HouseJoinRequest_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "House"("id") ON DELETE CASCADE ON UPDATE CASCADE;
