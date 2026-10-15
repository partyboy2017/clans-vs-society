#!/usr/bin/env node
// Run from the project root:  node fix-admin-and-hardening.js
// 1. Makes /api/admin/audit use the same ADMIN_EMAILS rule as admin-routes.js
// 2. Wraps audit() and pruneAudit() in try/catch so logging can never crash the app
// Each edit is independent; any anchor that isn't found is skipped and reported.
const fs = require('fs');
const f = 'server.js';
let s = fs.readFileSync(f, 'utf8');
fs.writeFileSync(f + '.bak2', s);
const done = [], skipped = [];

function swap(name, from, to) {
  const n = s.split(from).length - 1;
  if (n === 1) { s = s.replace(from, () => to); done.push(name); }
  else skipped.push(`${name} (anchor matched ${n} times)`);
}

// 1a. replace ADMIN_IDS definition with the email-based check
const idsRe = /const ADMIN_IDS = \(process\.env\.ADMIN_USER_IDS \|\| ''\)\r?\n\s*\.split\(','\)\.map\(s => parseInt\(s, 10\)\)\.filter\(Boolean\);/;
if (idsRe.test(s)) {
  s = s.replace(idsRe, () =>
`// Same admin rule as admin-routes.js (ADMIN_EMAILS), so there is one admin system.
const adminEmails = () =>
  (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
const isAdmin = (req) =>
  req.isAuthenticated() && req.user.email && adminEmails().includes(req.user.email.toLowerCase());`);
  done.push('ADMIN_IDS -> ADMIN_EMAILS definition');
} else skipped.push('ADMIN_IDS definition (not found; already changed?)');

// 1b. the route's guard
const guardRe = /if \(!req\.isAuthenticated\(\) \|\| !ADMIN_IDS\.includes\(req\.user\.id\)\)/;
if (guardRe.test(s)) {
  s = s.replace(guardRe, () => 'if (!isAdmin(req))');
  done.push('route guard uses isAdmin(req)');
} else skipped.push('route guard (not found; already changed?)');

// 2a. harden audit()
swap('audit() try/catch',
`function audit(req, action, { targetUserId = null, metadata = null, userId } = {}) {
  prisma.auditLog.create({
    data: {
      userId:       userId ?? req?.user?.id ?? null,
      targetUserId,
      action,
      metadata,
      ip:           req?.ip ?? null,
      userAgent:    (req?.get?.('user-agent') || '').slice(0, 255) || null,
    },
  }).catch(err => logError('audit error:', err));
}`,
`function audit(req, action, { targetUserId = null, metadata = null, userId } = {}) {
  try {
    prisma.auditLog.create({
      data: {
        userId:       userId ?? req?.user?.id ?? null,
        targetUserId,
        action,
        metadata,
        ip:           req?.ip ?? null,
        userAgent:    (req?.get?.('user-agent') || '').slice(0, 255) || null,
      },
    }).catch(err => logError('audit error:', err));
  } catch (err) {
    logError('audit error:', err); // e.g. Prisma client not regenerated yet
  }
}`);

// 2b. harden pruneAudit()
swap('pruneAudit() try/catch',
`async function pruneAudit() {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400000);
  await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }).catch(logError);
}`,
`async function pruneAudit() {
  try {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400000);
    await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (err) {
    logError('pruneAudit error:', err);
  }
}`);

fs.writeFileSync(f, s);
try { require('child_process').execSync(`node --check ${f}`, { stdio: 'inherit' }); }
catch { fs.copyFileSync(f + '.bak2', f); console.error('Syntax check failed; restored backup.'); process.exit(1); }

console.log('Applied:\n  - ' + (done.join('\n  - ') || 'nothing'));
if (skipped.length) console.log('Skipped:\n  - ' + skipped.join('\n  - '));
console.log('\nBackup: server.js.bak2. Restart the server (Ctrl+C, npm run dev).');
