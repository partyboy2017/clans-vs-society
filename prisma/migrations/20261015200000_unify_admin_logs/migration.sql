-- Merges the two admin systems onto User.role + AuditLog.
--
-- 20261015000000_add_admin_panel created User."isAdmin", "LoginEvent" and
-- "AdminAuditLog". Those are replaced by User.role and the AuditLog table, so
-- any rows already written are copied across before the old objects are
-- dropped. Every step checks for existence first, so this is safe whether or
-- not the earlier migration ever ran against this database.

-- 1. isAdmin = true → role = 'admin'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'User' AND column_name = 'isAdmin') THEN
    UPDATE "User" SET "role" = 'admin' WHERE "isAdmin" = true AND "role" = 'player';
    ALTER TABLE "User" DROP COLUMN "isAdmin";
  END IF;
END $$;

-- 2. LoginEvent → AuditLog (auth.login / auth.logout). Kicks are already in
--    AdminAuditLog as admin actions, so they come across in step 3.
DO $$ BEGIN
  IF to_regclass('"LoginEvent"') IS NOT NULL THEN
    INSERT INTO "AuditLog" ("userId", "action", "ip", "userAgent", "createdAt")
    SELECT "userId", 'auth.' || "type", "ip", "userAgent", "createdAt"
    FROM "LoginEvent" WHERE "type" IN ('login', 'logout');
    DROP TABLE "LoginEvent";
  END IF;
END $$;

-- 3. AdminAuditLog → AuditLog (admin.*)
DO $$ BEGIN
  IF to_regclass('"AdminAuditLog"') IS NOT NULL THEN
    INSERT INTO "AuditLog" ("userId", "targetUserId", "action", "metadata", "createdAt")
    SELECT "adminId", "targetUserId", 'admin.' || "action",
           CASE WHEN "details" IS NULL OR "details" = '' THEN NULL ELSE "details"::jsonb END,
           "createdAt"
    FROM "AdminAuditLog";
    DROP TABLE "AdminAuditLog";
  END IF;
END $$;
