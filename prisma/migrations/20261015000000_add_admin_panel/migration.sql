-- Admin panel: roles, presence, bans, login log, audit log, error log,
-- feedback inbox, announcements.
-- Written with IF NOT EXISTS so it is safe on databases that were partly
-- created with `prisma db push`.

-- User fields
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenAt"  TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isAdmin"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "banReason"   TEXT;

-- LoginEvent
CREATE TABLE IF NOT EXISTS "LoginEvent" (
    "id"        SERIAL NOT NULL,
    "userId"    INTEGER NOT NULL,
    "type"      TEXT NOT NULL,
    "ip"        TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LoginEvent_userId_createdAt_idx" ON "LoginEvent"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "LoginEvent_createdAt_idx" ON "LoginEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "LoginEvent_ip_idx" ON "LoginEvent"("ip");
DO $$ BEGIN
  ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AdminAuditLog
CREATE TABLE IF NOT EXISTS "AdminAuditLog" (
    "id"           SERIAL NOT NULL,
    "adminId"      INTEGER NOT NULL,
    "adminName"    TEXT NOT NULL,
    "action"       TEXT NOT NULL,
    "targetUserId" INTEGER,
    "details"      TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_targetUserId_idx" ON "AdminAuditLog"("targetUserId");

-- ErrorLog
CREATE TABLE IF NOT EXISTS "ErrorLog" (
    "id"        SERIAL NOT NULL,
    "message"   TEXT NOT NULL,
    "stack"     TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ErrorLog_createdAt_idx" ON "ErrorLog"("createdAt");

-- Feedback
CREATE TABLE IF NOT EXISTS "Feedback" (
    "id"        SERIAL NOT NULL,
    "userId"    INTEGER NOT NULL,
    "category"  TEXT NOT NULL,
    "message"   TEXT NOT NULL,
    "resolved"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Feedback_resolved_createdAt_idx" ON "Feedback"("resolved", "createdAt");
DO $$ BEGIN
  ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Announcement
CREATE TABLE IF NOT EXISTS "Announcement" (
    "id"        SERIAL NOT NULL,
    "message"   TEXT NOT NULL,
    "active"    BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- GoldSnapshot
CREATE TABLE IF NOT EXISTS "GoldSnapshot" (
    "id"      SERIAL NOT NULL,
    "userId"  INTEGER NOT NULL,
    "gold"    INTEGER NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GoldSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "GoldSnapshot_takenAt_idx" ON "GoldSnapshot"("takenAt");
CREATE INDEX IF NOT EXISTS "GoldSnapshot_userId_takenAt_idx" ON "GoldSnapshot"("userId", "takenAt");
