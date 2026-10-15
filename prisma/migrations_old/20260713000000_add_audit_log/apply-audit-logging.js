#!/usr/bin/env node
// Usage (from your project root):  node apply-audit-logging.js
// Patches server.js and prisma/schema.prisma in place, and adds the migration.
// All edits are computed in memory first; nothing is written unless every
// anchor matches exactly once. Back up (or commit) before running.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const SERVER = path.join(ROOT, 'server.js');
const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
const MIG_DIR = path.join(ROOT, 'prisma', 'migrations', '20260713000000_add_audit_log');
const BT = '`';

let server = fs.readFileSync(SERVER, 'utf8');
let schema = fs.readFileSync(SCHEMA, 'utf8');

if (server.includes('function audit(') || schema.includes('model AuditLog')) {
  console.error('Audit logging already appears to be applied. Aborting.');
  process.exit(1);
}

const errors = [];
function rep(name, anchor, replacement) {
  const n = server.split(anchor).length - 1;
  if (n !== 1) { errors.push(`${name}: anchor matched ${n} times (expected 1)`); return; }
  server = server.replace(anchor, () => replacement);
}
const after  = (name, anchor, add) => rep(name, anchor, anchor + add);

function prepend(name, anchor, add) { rep(name, anchor, add + anchor); }

// ── infrastructure ───────────────────────────────────────────────────────────
prepend('trust proxy', 'app.use(express.json());',
`// Railway sits behind a proxy; without this req.ip is the proxy's address.
app.set('trust proxy', 1);
`);

after('audit helper',
`function logActivity(userId, category, message) {
  prisma.activityLog.create({ data: { userId, category, message } })
    .catch(err => logError('logActivity error:', err));
}`,
`

// Fire-and-forget audit write. Like logActivity, a logging failure must never
// break gameplay. Unlike logActivity this is for admins, not players, so it
// records IP/user-agent and structured metadata. Never put secrets or free-text
// user content (passwords, feedback bodies) in metadata.
function audit(req, action, { targetUserId = null, metadata = null, userId } = {}) {
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
}`);

// ── auth ─────────────────────────────────────────────────────────────────────
prepend('auth.login',
`    if (!req.user.characterName)  return res.redirect('/choose-name');
    if (!req.user.characterClass) return res.redirect('/choose-class');
    res.redirect('/dashboard');
  }
);`.split('\n')[0],
`    audit(req, 'auth.login');
`);

after('auth.logout', `app.post('/api/logout', (req, res) => {`,
`
  audit(req, 'auth.logout'); // before req.logout clears req.user`);

// ── identity ─────────────────────────────────────────────────────────────────
after('name_chosen',
`    await prisma.user.update({ where: { id: req.user.id }, data: { characterName: clean } });`,
`
    audit(req, 'character.name_chosen', { metadata: { characterName: clean } });`);

prepend('class_chosen', `    // Refresh the session so req.user.characterClass is set before the`,
`    audit(req, 'character.class_chosen', { metadata: { characterClass } });

`);

// ── economy ──────────────────────────────────────────────────────────────────
after('shop.buy',
`    logActivity(req.user.id, 'inventory', ${BT}Bought \${qty}x \${item.name} for \${cost} gold.${BT});`,
`
    audit(req, 'shop.buy', { metadata: { itemId: item.id, qty, cost } });`);

after('shop.sell',
`    logActivity(req.user.id, 'inventory', ${BT}Sold \${result.qty}x \${result.itemName} for \${result.totalValue} gold.${BT});`,
`
    audit(req, 'shop.sell', { metadata: { inventoryId, qty: result.qty, gold: result.totalValue } });`);

prepend('market.buy', `    res.json({ ok: true, item: listing.item.name });`,
`    audit(req, 'market.buy', {
      targetUserId: listing.sellerId,
      metadata: { listingId, itemId: listing.itemId, qty: listing.quantity, price: listing.price },
    });
`);

rep('market.buy_denied',
`    if (e.code === 'OWN_LISTING') return res.status(400).json({ error: 'You cannot buy your own listing' });`,
`    if (e.code === 'OWN_LISTING') {
      audit(req, 'market.buy_denied', { metadata: { listingId, reason: 'own_listing' } });
      return res.status(400).json({ error: 'You cannot buy your own listing' });
    }`);

after('market.list',
`  await prisma.listing.create({ data: { sellerId: req.user.id, itemId: inv.itemId, price, quantity } });`,
`
  audit(req, 'market.list', { metadata: { itemId: inv.itemId, price, quantity } });`);

// ── PvP / raids ──────────────────────────────────────────────────────────────
prepend('raid.player', `    res.json({
      ...result,
      targetName: target.characterName,`,
`    audit(req, 'raid.player', {
      targetUserId: targetId,
      metadata: { won: result.won, goldStolen: result.goldStolen, defenderHospitalized: result.defenderHospitalized },
    });

`);

prepend('raid.npc', `    res.json({ ...result, location: location.name, ...levelUp });`,
`    audit(req, 'raid.npc', {
      metadata: { locationId, won: result.won, goldGain: result.goldGain, jailMins: result.jailMins },
    });

`);

// ── progression / spending ───────────────────────────────────────────────────
rep('skill.denied',
`    return res.status(403).json({ error: 'That skill does not belong to your class' });`,
`  {
    audit(req, 'skill.unlock_denied', { metadata: { skillKey, reason: 'wrong_class' } });
    return res.status(403).json({ error: 'That skill does not belong to your class' });
  }`);

after('skill.unlock',
`    logActivity(req.user.id, 'level', ${BT}Unlocked skill: \${skill.name} (-\${skill.cost} stat points).${BT});`,
`
    audit(req, 'skill.unlock', { metadata: { skillKey, cost: skill.cost } });`);

prepend('stat.spend', `  res.json({ ok: true, stat, newValue: updated[stat] });`,
`  audit(req, 'stat.spend', { metadata: { stat } });
`);

prepend('house.create', `    res.json({ ok: true, house });`,
`    audit(req, 'house.create', { metadata: { houseId: house.id, name: house.name } });
`);

after('house.join',
`  await prisma.houseMember.create({ data: { userId: req.user.id, houseId, rank: 'Bannerman' } });`,
`
  audit(req, 'house.join', { metadata: { houseId } });`);

after('house.leave',
`  await prisma.houseMember.delete({ where: { userId: req.user.id } });`,
`
  audit(req, 'house.leave', { metadata: { houseId: member.houseId } });`);

prepend('wagon.build',
`    logActivity(req.user.id, 'level', ${BT}Acquired the \${req._builtTierName}!`,
`    audit(req, 'wagon.build', { metadata: { tier: req._builtTierName } });
`);

after('feedback',
`  logActivity(req.user.id, 'feedback', ${BT}Submitted \${category.toLowerCase()}.${BT});`,
`
  audit(req, 'feedback.submit', { metadata: { category } }); // never log the message body`);

// ── admin endpoint + retention ───────────────────────────────────────────────
prepend('admin+prune', `const PORT = process.env.PORT || 3000;`,
`// ─── ADMIN: audit log ─────────────────────────────────────────────────────────
// Set ADMIN_USER_IDS=1,2 in the environment to grant access.
const ADMIN_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',').map(s => parseInt(s, 10)).filter(Boolean);

app.get('/api/admin/audit', async (req, res) => {
  if (!req.isAuthenticated() || !ADMIN_IDS.includes(req.user.id))
    return res.status(404).json({ error: 'Not found' }); // 404 so it doesn't advertise itself

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const where = {};
  const uid = parseInt(req.query.userId, 10);
  if (uid) where.OR = [{ userId: uid }, { targetUserId: uid }];
  if (req.query.action) where.action = { startsWith: String(req.query.action) };

  try {
    const entries = await prisma.auditLog.findMany({
      where, orderBy: { createdAt: 'desc' }, take: limit,
    });
    res.json({ entries });
  } catch (e) {
    logError('/api/admin/audit error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Retention: keep 90 days of audit history.
const AUDIT_RETENTION_DAYS = 90;
async function pruneAudit() {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400000);
  await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }).catch(logError);
}
pruneAudit();
setInterval(pruneAudit, 24 * 60 * 60 * 1000);

`);

if (errors.length) {
  console.error('No files were changed. Problems found:\n  - ' + errors.join('\n  - '));
  console.error('\nYour server.js has likely diverged from the version this was written against.');
  process.exit(1);
}

// ── write ────────────────────────────────────────────────────────────────────
const model = fs.readFileSync(path.join(__dirname, 'prisma', 'audit-model.prisma.txt'), 'utf8');
schema = schema.replace(/\s*$/, '\n') + model;
const migSql = fs.readFileSync(path.join(__dirname, 'prisma', 'migrations', '20260713000000_add_audit_log', 'migration.sql'), 'utf8');

fs.writeFileSync(SERVER + '.bak', fs.readFileSync(SERVER));
fs.writeFileSync(SCHEMA + '.bak', fs.readFileSync(SCHEMA));
fs.writeFileSync(SERVER, server);
fs.writeFileSync(SCHEMA, schema);
fs.mkdirSync(MIG_DIR, { recursive: true });
fs.writeFileSync(path.join(MIG_DIR, 'migration.sql'), migSql);

try {
  execSync(`node --check "${SERVER}"`, { stdio: 'inherit' });
  console.log('server.js syntax OK.');
} catch {
  console.error('Syntax check failed. Restoring backups.');
  fs.copyFileSync(SERVER + '.bak', SERVER);
  fs.copyFileSync(SCHEMA + '.bak', SCHEMA);
  process.exit(1);
}

console.log(`
Done. Backups: server.js.bak, prisma/schema.prisma.bak
Next steps:
  1. npx prisma validate && npx prisma generate
  2. Set ADMIN_USER_IDS in your environment (e.g. ADMIN_USER_IDS=1)
  3. Deploy (your build script runs 'prisma migrate deploy')
`);
