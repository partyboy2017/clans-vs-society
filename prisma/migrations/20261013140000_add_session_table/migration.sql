-- connect-pg-simple already creates this table at runtime (createTableIfMissing),
-- so every statement is idempotent: safe on your existing DB and on a fresh/shadow one.
CREATE TABLE IF NOT EXISTS "session" (
    "sid" VARCHAR NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session"("expire");
