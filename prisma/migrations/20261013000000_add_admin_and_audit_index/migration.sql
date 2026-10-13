-- AlterTable
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ActivityLog_userId_category_createdAt_idx" ON "ActivityLog"("userId", "category", "createdAt");
