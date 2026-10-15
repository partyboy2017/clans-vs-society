#!/usr/bin/env node
// scripts/baseline-migrations.js — runs before `prisma migrate deploy` (see "build" in package.json).
//
// The migration history was re-baselined into prisma/migrations/0_init. A
// database that already has the game's tables (production, or anyone's local
// DB) would otherwise make `migrate deploy` try to CREATE TABLE "User" again
// and fail. For each migration below, if the database already contains what
// that migration creates but Prisma has no record of it, this marks it as
// applied with `prisma migrate resolve --applied`. A brand-new, empty
// database is left alone, so `migrate deploy` builds it from scratch.
//
// Safe to run on every deploy: once a migration is recorded, it is skipped.

const { execFileSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

// migration name → SQL that returns true when its changes are already present
const CHECKS = [
  ['0_init',                           `SELECT to_regclass('"User"') IS NOT NULL AS present`],
  ['20261009022858_add_audit_log',     `SELECT to_regclass('"AuditLog"') IS NOT NULL AS present`],
  ['20261013150000_add_user_role',     `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                                          WHERE table_schema = current_schema() AND table_name = 'User' AND column_name = 'role') AS present`],
];

async function main() {
  const prisma = new PrismaClient();
  try {
    const hasHistory = (await prisma.$queryRawUnsafe(
      `SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS present`))[0].present;
    const applied = new Set(hasHistory
      ? (await prisma.$queryRawUnsafe(
          `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`))
          .map(r => r.migration_name)
      : []);

    const toResolve = [];
    for (const [name, sql] of CHECKS) {
      if (applied.has(name)) continue;
      const present = (await prisma.$queryRawUnsafe(sql))[0].present;
      if (present) toResolve.push(name);
    }
    await prisma.$disconnect();

    for (const name of toResolve) {
      console.log(`[baseline] ${name}: already present in the database, marking as applied`);
      execFileSync('npx', ['prisma', 'migrate', 'resolve', '--applied', name], { stdio: 'inherit' });
    }
    if (!toResolve.length) console.log('[baseline] nothing to mark; migration history is up to date');
  } catch (err) {
    await prisma.$disconnect().catch(() => {});
    console.error('[baseline] failed:', err.message || err);
    process.exit(1);
  }
}

main();
