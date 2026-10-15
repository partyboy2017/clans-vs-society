// admin.js — admin panel backend for Clans vs Society.
//
// Exposes:
//   installPresence(app, deps)       — ban enforcement + "last seen" tracking (mount after passport.session)
//   recordLoginEvent(prisma, req, userId, type)
//   persistError(prisma, args)       — store a logError() call in ErrorLog
//   isAdminEmail(email)              — ADMIN_EMAILS env bootstrap
//   startBackgroundJobs(deps)        — hourly gold snapshots + log pruning
//   registerAdminRoutes(app, deps)   — /admin page + /api/admin/* endpoints
//
// Every /api/admin route goes through requireAdmin, and every change an admin
// makes is written to AdminAuditLog with before/after values.

const path = require('path');
const { z } = require('zod');

const ONLINE_WINDOW_MS     = 5 * 60 * 1000;       // "online now" = seen in last 5 min
const LAST_SEEN_THROTTLE_MS = 60 * 1000;          // write lastSeenAt at most once a minute per player
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;      // hourly gold snapshots
const SNAPSHOT_KEEP_DAYS   = 14;
const ERROR_KEEP_DAYS      = 30;
const PAGE_SIZE            = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminEmail(email) {
  return !!email && adminEmails().includes(String(email).toLowerCase());
}

function clientIp(req) {
  // `trust proxy` is set in server.js, so req.ip is the real client IP behind Railway.
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;
}

function isBanned(user, now = Date.now()) {
  return !!(user && user.bannedUntil && new Date(user.bannedUntil).getTime() > now);
}

function recordLoginEvent(prisma, req, userId, type) {
  return prisma.loginEvent.create({
    data: {
      userId,
      type,
      ip:        req ? clientIp(req) : null,
      userAgent: req ? (req.get('user-agent') || '').slice(0, 300) || null : null,
    },
  }).catch(err => console.error('recordLoginEvent error:', err));
}

let persistingError = false;
function persistError(prisma, args) {
  if (persistingError) return; // never recurse if the error table itself is failing
  try {
    const err     = args.find(a => a instanceof Error);
    const message = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a)))
      .join(' ').slice(0, 2000);
    persistingError = true;
    prisma.errorLog.create({ data: { message: message || 'Unknown error', stack: err?.stack?.slice(0, 8000) || null } })
      .catch(e => console.error('persistError failed:', e.message))
      .finally(() => { persistingError = false; });
  } catch (e) {
    persistingError = false;
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ─── Presence + bans ──────────────────────────────────────────────────────────

const lastSeenWrites = new Map(); // userId -> ms of last DB write

function installPresence(app, { prisma }) {
  app.use(async (req, res, next) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) return next();
    const user = req.user;

    if (isBanned(user)) {
      // Let the logout endpoints through so the client can clean up.
      if (req.path === '/api/logout' || req.path === '/logout') return next();
      const until  = new Date(user.bannedUntil);
      const reason = user.banReason || '';
      return req.logout(() => {
        req.session.destroy(() => {
          res.clearCookie('connect.sid');
          if (req.path.startsWith('/api/')) {
            return res.status(403).json({ error: 'Your account is banned.', banned: true, reason, until });
          }
          res.redirect('/?banned=1');
        });
      });
    }

    const now  = Date.now();
    const last = lastSeenWrites.get(user.id) || 0;
    if (now - last > LAST_SEEN_THROTTLE_MS) {
      lastSeenWrites.set(user.id, now);
      prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date(now) } })
        .catch(err => console.error('lastSeenAt update error:', err.message));
    }
    next();
  });
}

// ─── Background jobs ──────────────────────────────────────────────────────────

async function takeGoldSnapshot(prisma) {
  const latest = await prisma.goldSnapshot.findFirst({ orderBy: { takenAt: 'desc' }, select: { takenAt: true } });
  // Guard against duplicate snapshots after quick restarts.
  if (latest && Date.now() - latest.takenAt.getTime() < SNAPSHOT_INTERVAL_MS - 5 * 60 * 1000) return;

  const takenAt = new Date();
  const rows = await prisma.stats.findMany({ select: { userId: true, gold: true } });
  if (rows.length) {
    await prisma.goldSnapshot.createMany({ data: rows.map(r => ({ userId: r.userId, gold: r.gold, takenAt })) });
  }
  await prisma.goldSnapshot.deleteMany({ where: { takenAt: { lt: new Date(Date.now() - SNAPSHOT_KEEP_DAYS * 864e5) } } });
  await prisma.errorLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - ERROR_KEEP_DAYS * 864e5) } } });
}

function startBackgroundJobs({ prisma, logError }) {
  const run = () => takeGoldSnapshot(prisma).catch(err => logError('Gold snapshot error:', err));
  setTimeout(run, 15 * 1000).unref();
  setInterval(run, SNAPSHOT_INTERVAL_MS).unref();
}

// ─── Validation ───────────────────────────────────────────────────────────────

const int0 = () => z.coerce.number().int().min(0);

const EDITABLE_STATS = [
  'level', 'xp', 'statPoints', 'gold',
  'strength', 'defense', 'speed', 'dexterity', 'intelligence',
  'health', 'maxHealth', 'energy', 'maxEnergy',
];

const COOLDOWN_FIELDS = [
  'lastStrengthTrain', 'lastDefenseTrain', 'lastSpeedTrain', 'lastDexTrain',
  'lastRaidVillageAt', 'lastRaidCaravanAt', 'lastRaidManorAt', 'lastRaidTreasuryAt',
];

const adminSchemas = {
  stats: z.object(Object.fromEntries(EDITABLE_STATS.map(k => [k, int0().max(1_000_000_000).optional()])))
    .refine(o => Object.keys(o).length > 0, 'No fields to update'),
  giveItem: z.object({ itemId: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1).max(10000) }),
  removeItem: z.object({ inventoryId: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1).max(10000) }),
  release: z.object({ what: z.enum(['jail', 'hospital', 'both']) }),
  ban: z.object({
    days:   z.coerce.number().min(0).max(36500).nullable().optional(), // null/0 = permanent
    reason: z.string().trim().max(300).optional(),
  }),
  setAdmin: z.object({ isAdmin: z.boolean() }),
  item: z.object({
    name:        z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000),
    type:        z.string().trim().min(1).max(40),
    effect:      z.string().trim().max(200),
    basePrice:   int0().max(10_000_000),
    icon:        z.string().trim().max(300).optional(),
  }),
  house: z.object({
    name:  z.string().trim().min(2).max(30).optional(),
    motto: z.string().trim().max(100).optional(),
    gold:  int0().max(1_000_000_000).optional(),
  }),
  houseLeader: z.object({ userId: z.coerce.number().int().positive() }),
  removeListing: z.object({ returnToSeller: z.boolean().default(true) }),
  feedback: z.object({ resolved: z.boolean() }),
  announcement: z.object({
    message:   z.string().trim().min(1).max(500),
    hours:     z.coerce.number().min(0).max(24 * 365).nullable().optional(), // null/0 = until turned off
  }),
  announcementToggle: z.object({ active: z.boolean() }),
};

// ─── Routes ───────────────────────────────────────────────────────────────────

function registerAdminRoutes(app, { prisma, logError, validate, CLASSES }) {
  function requireAdmin(req, res, next) {
    if (!req.isAuthenticated() || !req.user?.isAdmin) {
      return req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')
        ? res.status(403).json({ error: 'Admins only' })
        : res.status(404).send('Not found');
    }
    next();
  }

  // Wraps async handlers so a thrown error becomes a logged 500 instead of a crash.
  const h = fn => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      if (e && e.code === 'P2002') return res.status(409).json({ error: 'That name is already taken' });
      if (e && e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      logError(`[admin] ${req.method} ${req.originalUrl} error:`, e);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };

  const fail = (status, message) => Object.assign(new Error(message), { status });

  function audit(req, action, targetUserId, details) {
    return prisma.adminAuditLog.create({
      data: {
        adminId:   req.user.id,
        adminName: req.user.characterName || req.user.username,
        action,
        targetUserId: targetUserId ?? null,
        details:   safeJson(details ?? {}),
      },
    }).catch(err => logError('audit log error:', err));
  }

  const userId = req => {
    const n = parseInt(req.params.id, 10);
    if (!Number.isInteger(n) || n <= 0) throw fail(400, 'Bad player id');
    return n;
  };

  async function getPlayer(id) {
    const u = await prisma.user.findUnique({ where: { id }, include: { stats: true } });
    if (!u) throw fail(404, 'Player not found');
    return u;
  }

  const playerName = u => u.characterName || u.username;

  async function kickSessions(id) {
    // connect-pg-simple stores the session as JSON: { passport: { user: <id> } }
    return prisma.$executeRaw`DELETE FROM "session" WHERE sess->'passport'->>'user' = ${String(id)}`;
  }

  // ── Page ──
  app.get('/admin', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
  });

  app.use('/api/admin', requireAdmin);

  // ── Overview ──
  app.get('/api/admin/overview', h(async (req, res) => {
    const now = Date.now();
    const ago = ms => new Date(now - ms);

    const [
      totalPlayers, onlineNow, active24h, active7d, new24h, new7d,
      classRows, levelAgg, goldAgg, houseGoldAgg, openFeedback, errors24h, bannedCount,
      loginRows,
    ] = await Promise.all([
      prisma.user.count({ where: { characterName: { not: null } } }),
      prisma.user.count({ where: { lastSeenAt: { gte: ago(ONLINE_WINDOW_MS) } } }),
      prisma.user.count({ where: { lastSeenAt: { gte: ago(864e5) } } }),
      prisma.user.count({ where: { lastSeenAt: { gte: ago(7 * 864e5) } } }),
      prisma.user.count({ where: { createdAt: { gte: ago(864e5) } } }),
      prisma.user.count({ where: { createdAt: { gte: ago(7 * 864e5) } } }),
      prisma.user.groupBy({ by: ['characterClass'], _count: { _all: true } }),
      prisma.stats.aggregate({ _avg: { level: true }, _max: { level: true } }),
      prisma.stats.aggregate({ _sum: { gold: true } }),
      prisma.house.aggregate({ _sum: { gold: true } }),
      prisma.feedback.count({ where: { resolved: false } }),
      prisma.errorLog.count({ where: { createdAt: { gte: ago(864e5) } } }),
      prisma.user.count({ where: { bannedUntil: { gt: new Date(now) } } }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS logins,
               COUNT(DISTINCT "userId")::int AS players
        FROM "LoginEvent"
        WHERE type = 'login' AND "createdAt" >= ${ago(14 * 864e5)}
        GROUP BY 1 ORDER BY 1`,
    ]);

    res.json({
      totalPlayers, onlineNow, active24h, active7d, new24h, new7d, bannedCount,
      avgLevel: Math.round((levelAgg._avg.level || 0) * 10) / 10,
      maxLevel: levelAgg._max.level || 0,
      playerGold: goldAgg._sum.gold || 0,
      houseGold:  houseGoldAgg._sum.gold || 0,
      openFeedback, errors24h,
      classes: classRows
        .map(r => ({ cls: r.characterClass, label: r.characterClass ? (CLASSES[r.characterClass]?.label || r.characterClass) : 'No class yet', count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      loginsByDay: loginRows,
    });
  }));

  // ── Online now ──
  app.get('/api/admin/online', h(async (req, res) => {
    const players = await prisma.user.findMany({
      where: { lastSeenAt: { gte: new Date(Date.now() - ONLINE_WINDOW_MS) } },
      select: {
        id: true, characterName: true, username: true, characterClass: true, lastSeenAt: true, lastLoginAt: true,
        stats: { select: { level: true, currentCityId: true } },
      },
      orderBy: { lastSeenAt: 'desc' },
    });
    res.json(players);
  }));

  // ── Players list ──
  app.get('/api/admin/players', h(async (req, res) => {
    const q    = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = String(req.query.filter || 'all');
    const sort = String(req.query.sort || 'lastSeen');

    const where = { AND: [] };
    if (q) {
      const asId = parseInt(q, 10);
      where.AND.push({
        OR: [
          { characterName: { contains: q, mode: 'insensitive' } },
          { username:      { contains: q, mode: 'insensitive' } },
          { email:         { contains: q, mode: 'insensitive' } },
          ...(String(asId) === q ? [{ id: asId }] : []),
        ],
      });
    }
    if (filter === 'online') where.AND.push({ lastSeenAt: { gte: new Date(Date.now() - ONLINE_WINDOW_MS) } });
    if (filter === 'banned') where.AND.push({ bannedUntil: { gt: new Date() } });
    if (filter === 'admins') where.AND.push({ isAdmin: true });
    if (filter === 'jailed') where.AND.push({ stats: { OR: [{ inJail: true }, { inHospital: true }] } });

    const orderBy = {
      lastSeen: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }],
      level:    [{ stats: { level: 'desc' } }],
      gold:     [{ stats: { gold: 'desc' } }],
      newest:   [{ createdAt: 'desc' }],
    }[sort] || [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }];

    const [total, players] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where, orderBy,
        skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
        select: {
          id: true, username: true, characterName: true, email: true, characterClass: true,
          isAdmin: true, bannedUntil: true, lastSeenAt: true, lastLoginAt: true, createdAt: true,
          stats: { select: { level: true, gold: true, inJail: true, inHospital: true, currentCityId: true } },
          houseMember: { select: { house: { select: { id: true, name: true } } } },
        },
      }),
    ]);
    res.json({ total, page, pageSize: PAGE_SIZE, players });
  }));

  // ── Player detail ──
  app.get('/api/admin/players/:id', h(async (req, res) => {
    const id = userId(req);
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        stats: true,
        houseMember: { include: { house: true } },
        inventory: { include: { item: true }, orderBy: { id: 'asc' } },
        userSkills: { orderBy: { unlockedAt: 'asc' } },
        combatSession: true,
        listings: { include: { item: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw fail(404, 'Player not found');

    const [activity, logins, audits, feedback] = await Promise.all([
      prisma.activityLog.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.loginEvent.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.adminAuditLog.findMany({ where: { targetUserId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.feedback.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);

    // Other accounts that have logged in from any IP this player used.
    const ips = [...new Set((await prisma.loginEvent.findMany({
      where: { userId: id, ip: { not: null } }, select: { ip: true }, distinct: ['ip'],
    })).map(r => r.ip))];
    let sharedIp = [];
    if (ips.length) {
      const rows = await prisma.loginEvent.findMany({
        where: { ip: { in: ips }, userId: { not: id } },
        distinct: ['userId', 'ip'],
        select: { ip: true, user: { select: { id: true, characterName: true, username: true } } },
      });
      sharedIp = rows.map(r => ({ ip: r.ip, id: r.user.id, name: r.user.characterName || r.user.username }));
    }

    const { password, googleId, ...safeUser } = user;
    res.json({ user: safeUser, activity, logins, audits, feedback, sharedIp, cooldownFields: COOLDOWN_FIELDS });
  }));

  // ── Player actions ──
  app.post('/api/admin/players/:id/stats', validate(adminSchemas.stats), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    if (!player.stats) throw fail(400, 'Player has no character stats yet');
    const before = {};
    for (const k of Object.keys(req.body)) before[k] = player.stats[k];
    const stats = await prisma.stats.update({ where: { userId: id }, data: req.body });
    await audit(req, 'edit_stats', id, { player: playerName(player), before, after: req.body });
    res.json({ ok: true, stats });
  }));

  app.post('/api/admin/players/:id/give-item', validate(adminSchemas.giveItem), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    const { itemId, quantity } = req.body;
    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) throw fail(404, 'Item not found');
    const existing = await prisma.inventory.findFirst({ where: { userId: id, itemId } });
    if (existing) await prisma.inventory.update({ where: { id: existing.id }, data: { quantity: { increment: quantity } } });
    else          await prisma.inventory.create({ data: { userId: id, itemId, quantity } });
    await audit(req, 'give_item', id, { player: playerName(player), item: item.name, itemId, quantity });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/remove-item', validate(adminSchemas.removeItem), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    const { inventoryId, quantity } = req.body;
    const inv = await prisma.inventory.findFirst({ where: { id: inventoryId, userId: id }, include: { item: true } });
    if (!inv) throw fail(404, 'Inventory entry not found');
    const removed = Math.min(quantity, inv.quantity);
    if (inv.quantity - removed <= 0) await prisma.inventory.delete({ where: { id: inv.id } });
    else await prisma.inventory.update({ where: { id: inv.id }, data: { quantity: inv.quantity - removed } });
    await audit(req, 'remove_item', id, { player: playerName(player), item: inv.item.name, quantity: removed });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/release', validate(adminSchemas.release), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    if (!player.stats) throw fail(400, 'Player has no character stats yet');
    const { what } = req.body;
    const data = {};
    if (what === 'jail' || what === 'both')     Object.assign(data, { inJail: false, jailUntil: null });
    if (what === 'hospital' || what === 'both') Object.assign(data, { inHospital: false, hospitalUntil: null });
    await prisma.stats.update({ where: { userId: id }, data });
    await audit(req, 'release', id, {
      player: playerName(player), what,
      before: { inJail: player.stats.inJail, jailUntil: player.stats.jailUntil, inHospital: player.stats.inHospital, hospitalUntil: player.stats.hospitalUntil },
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/cancel-travel', h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    if (!player.stats) throw fail(400, 'Player has no character stats yet');
    const fields = ['travelDestinationId', 'travelArrivalAt', 'travelDestination', 'travelStartedAt', 'travelArrivesAt'];
    const before = Object.fromEntries(fields.map(f => [f, player.stats[f]]));
    await prisma.stats.update({ where: { userId: id }, data: Object.fromEntries(fields.map(f => [f, null])) });
    await audit(req, 'cancel_travel', id, { player: playerName(player), before });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/clear-combat', h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    const session = await prisma.combatSession.findUnique({ where: { userId: id } });
    if (!session) throw fail(400, 'No fight in progress');
    await prisma.combatSession.delete({ where: { userId: id } });
    await audit(req, 'clear_combat', id, { player: playerName(player), monster: session.monsterName, zone: session.zoneId });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/reset-cooldowns', h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    if (!player.stats) throw fail(400, 'Player has no character stats yet');
    await prisma.stats.update({ where: { userId: id }, data: Object.fromEntries(COOLDOWN_FIELDS.map(f => [f, null])) });
    await audit(req, 'reset_cooldowns', id, { player: playerName(player) });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/kick', h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    const count = await kickSessions(id);
    lastSeenWrites.delete(id);
    await prisma.user.update({ where: { id }, data: { lastSeenAt: null } });
    await recordLoginEvent(prisma, null, id, 'kicked');
    await audit(req, 'kick', id, { player: playerName(player), sessionsEnded: count });
    res.json({ ok: true, sessionsEnded: count });
  }));

  app.post('/api/admin/players/:id/ban', validate(adminSchemas.ban), h(async (req, res) => {
    const id = userId(req);
    if (id === req.user.id) throw fail(400, "You can't ban yourself");
    const player = await getPlayer(id);
    const { days, reason } = req.body;
    const bannedUntil = days ? new Date(Date.now() + days * 864e5) : new Date('9999-12-31T00:00:00Z');
    await prisma.user.update({ where: { id }, data: { bannedUntil, banReason: reason || null } });
    const count = await kickSessions(id);
    await recordLoginEvent(prisma, null, id, 'kicked');
    await audit(req, 'ban', id, { player: playerName(player), days: days || 'permanent', reason: reason || null, sessionsEnded: count });
    res.json({ ok: true, bannedUntil });
  }));

  app.post('/api/admin/players/:id/unban', h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    await prisma.user.update({ where: { id }, data: { bannedUntil: null, banReason: null } });
    await audit(req, 'unban', id, { player: playerName(player), before: { bannedUntil: player.bannedUntil, banReason: player.banReason } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/admin', validate(adminSchemas.setAdmin), h(async (req, res) => {
    const id = userId(req);
    if (id === req.user.id && !req.body.isAdmin) throw fail(400, "You can't remove your own admin access");
    const player = await getPlayer(id);
    await prisma.user.update({ where: { id }, data: { isAdmin: req.body.isAdmin } });
    await audit(req, req.body.isAdmin ? 'grant_admin' : 'revoke_admin', id, { player: playerName(player) });
    res.json({ ok: true });
  }));

  // ── Login log ──
  app.get('/api/admin/logins', h(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const where = {};
    const uid = parseInt(req.query.userId, 10);
    if (uid > 0) where.userId = uid;
    if (req.query.ip) where.ip = String(req.query.ip);
    if (['login', 'logout', 'kicked'].includes(req.query.type)) where.type = req.query.type;
    if (req.query.q) {
      const q = String(req.query.q).trim();
      where.user = { OR: [
        { characterName: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
      ] };
    }
    const range = {};
    if (req.query.from) { const d = new Date(req.query.from); if (!isNaN(d)) range.gte = d; }
    if (req.query.to)   { const d = new Date(req.query.to);   if (!isNaN(d)) range.lte = new Date(d.getTime() + 864e5 - 1); }
    if (Object.keys(range).length) where.createdAt = range;

    const [total, events] = await Promise.all([
      prisma.loginEvent.count({ where }),
      prisma.loginEvent.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
        include: { user: { select: { id: true, characterName: true, username: true } } },
      }),
    ]);

    // Estimated session length for each login: time until that player's next
    // logout/kick, or until their last-seen time if they never logged out.
    const loginIds = events.filter(e => e.type === 'login').map(e => e.id);
    let durations = {};
    if (loginIds.length) {
      const rows = await prisma.$queryRaw`
        SELECT l.id,
          EXTRACT(EPOCH FROM (
            COALESCE(
              (SELECT MIN(o."createdAt") FROM "LoginEvent" o
                 WHERE o."userId" = l."userId" AND o."createdAt" > l."createdAt"
                   AND o.type IN ('logout','kicked')
                   AND o."createdAt" < COALESCE((SELECT MIN(n."createdAt") FROM "LoginEvent" n
                       WHERE n."userId" = l."userId" AND n.type = 'login' AND n."createdAt" > l."createdAt"), 'infinity')),
              CASE WHEN u."lastSeenAt" > l."createdAt"
                    AND u."lastSeenAt" < COALESCE((SELECT MIN(n."createdAt") FROM "LoginEvent" n
                       WHERE n."userId" = l."userId" AND n.type = 'login' AND n."createdAt" > l."createdAt"), 'infinity')
                   THEN u."lastSeenAt" END
            ) - l."createdAt"
          ))::int AS seconds,
          EXISTS (SELECT 1 FROM "LoginEvent" o
                   WHERE o."userId" = l."userId" AND o."createdAt" > l."createdAt" AND o.type IN ('logout','kicked')
                     AND o."createdAt" < COALESCE((SELECT MIN(n."createdAt") FROM "LoginEvent" n
                       WHERE n."userId" = l."userId" AND n.type = 'login' AND n."createdAt" > l."createdAt"), 'infinity')
          ) AS ended
        FROM "LoginEvent" l JOIN "User" u ON u.id = l."userId"
        WHERE l.id = ANY(${loginIds})`;
      durations = Object.fromEntries(rows.map(r => [r.id, { seconds: r.seconds, ended: r.ended }]));
    }

    res.json({
      total, page, pageSize: PAGE_SIZE,
      events: events.map(e => ({ ...e, session: durations[e.id] || null })),
    });
  }));

  // ── Economy ──
  app.get('/api/admin/economy', h(async (req, res) => {
    const [richest, series, gains, byLevel] = await Promise.all([
      prisma.stats.findMany({
        orderBy: { gold: 'desc' }, take: 20,
        select: { gold: true, level: true, user: { select: { id: true, characterName: true, username: true } } },
      }),
      prisma.$queryRaw`
        SELECT "takenAt" AS t, SUM(gold)::bigint AS total, COUNT(*)::int AS players
        FROM "GoldSnapshot"
        WHERE "takenAt" >= ${new Date(Date.now() - SNAPSHOT_KEEP_DAYS * 864e5)}
        GROUP BY "takenAt" ORDER BY "takenAt"`,
      // Biggest gold gain: current gold vs. the newest snapshot that is at least 24h old.
      prisma.$queryRaw`
        WITH past AS (
          SELECT DISTINCT ON ("userId") "userId", gold, "takenAt"
          FROM "GoldSnapshot"
          WHERE "takenAt" <= ${new Date(Date.now() - 864e5)}
          ORDER BY "userId", "takenAt" DESC
        )
        SELECT s."userId" AS id, COALESCE(u."characterName", u.username) AS name, s.level,
               s.gold AS now, p.gold AS then, (s.gold - p.gold) AS gain, p."takenAt" AS since
        FROM "Stats" s JOIN past p ON p."userId" = s."userId" JOIN "User" u ON u.id = s."userId"
        WHERE s.gold - p.gold > 0
        ORDER BY gain DESC LIMIT 20`,
      prisma.$queryRaw`
        SELECT level, COUNT(*)::int AS players, AVG(gold)::int AS avg_gold, MAX(gold)::int AS max_gold
        FROM "Stats" GROUP BY level ORDER BY level`,
    ]);

    const avgByLevel = Object.fromEntries(byLevel.map(r => [r.level, r.avg_gold]));
    res.json({
      richest: richest.map(r => ({
        id: r.user.id, name: r.user.characterName || r.user.username, level: r.level, gold: r.gold,
        levelAvg: avgByLevel[r.level] || 0,
        // Flag anyone holding 5x+ the average for their level (when there's a peer group to compare to).
        flagged: (byLevel.find(b => b.level === r.level)?.players || 0) >= 3 && r.gold > 5 * (avgByLevel[r.level] || 0) && r.gold > 1000,
      })),
      series: series.map(r => ({ t: r.t, total: Number(r.total), players: r.players })),
      gains: gains.map(g => ({ ...g, now: Number(g.now), then: Number(g.then), gain: Number(g.gain) })),
      byLevel,
    });
  }));

  // ── Market ──
  app.get('/api/admin/market', h(async (req, res) => {
    const listings = await prisma.listing.findMany({
      include: { item: true, seller: { select: { id: true, characterName: true, username: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(listings.map(l => ({
      ...l,
      unitPrice: l.quantity ? Math.round(l.price / l.quantity) : l.price,
      ratio: l.item.basePrice ? Math.round((l.price / Math.max(1, l.quantity)) / l.item.basePrice * 10) / 10 : null,
    })));
  }));

  app.post('/api/admin/market/:listingId/remove', validate(adminSchemas.removeListing), h(async (req, res) => {
    const listingId = parseInt(req.params.listingId, 10);
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { item: true } });
    if (!listing) throw fail(404, 'Listing not found');
    await prisma.$transaction(async tx => {
      await tx.listing.delete({ where: { id: listingId } });
      if (req.body.returnToSeller) {
        const existing = await tx.inventory.findFirst({ where: { userId: listing.sellerId, itemId: listing.itemId } });
        if (existing) await tx.inventory.update({ where: { id: existing.id }, data: { quantity: { increment: listing.quantity } } });
        else await tx.inventory.create({ data: { userId: listing.sellerId, itemId: listing.itemId, quantity: listing.quantity } });
      }
    });
    await audit(req, 'remove_listing', listing.sellerId, {
      item: listing.item.name, quantity: listing.quantity, price: listing.price, returnedToSeller: req.body.returnToSeller,
    });
    res.json({ ok: true });
  }));

  // ── Items ──
  app.get('/api/admin/items', h(async (req, res) => {
    const items = await prisma.item.findMany({
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { inventory: true, listings: true } } },
    });
    res.json(items);
  }));

  app.post('/api/admin/items', validate(adminSchemas.item), h(async (req, res) => {
    const data = { ...req.body };
    if (!data.icon) delete data.icon;
    const item = await prisma.item.create({ data });
    await audit(req, 'create_item', null, { item: data });
    res.json({ ok: true, item });
  }));

  app.post('/api/admin/items/:itemId', validate(adminSchemas.item), h(async (req, res) => {
    const itemId = parseInt(req.params.itemId, 10);
    const before = await prisma.item.findUnique({ where: { id: itemId } });
    if (!before) throw fail(404, 'Item not found');
    const data = { ...req.body };
    if (!data.icon) delete data.icon;
    const item = await prisma.item.update({ where: { id: itemId }, data });
    const changed = Object.keys(data).filter(k => before[k] !== data[k]);
    await audit(req, 'edit_item', null, {
      itemId, name: item.name,
      before: Object.fromEntries(changed.map(k => [k, before[k]])),
      after:  Object.fromEntries(changed.map(k => [k, data[k]])),
    });
    res.json({ ok: true, item });
  }));

  // ── Houses ──
  app.get('/api/admin/houses', h(async (req, res) => {
    const houses = await prisma.house.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        members: {
          include: { user: { select: { id: true, characterName: true, username: true, lastSeenAt: true, stats: { select: { level: true } } } } },
        },
      },
    });
    res.json(houses.map(hs => {
      const lastActive = hs.members.reduce((m, x) => (x.user.lastSeenAt && (!m || x.user.lastSeenAt > m) ? x.user.lastSeenAt : m), null);
      return { ...hs, lastActive };
    }));
  }));

  app.post('/api/admin/houses/:houseId', validate(adminSchemas.house), h(async (req, res) => {
    const houseId = parseInt(req.params.houseId, 10);
    const before = await prisma.house.findUnique({ where: { id: houseId } });
    if (!before) throw fail(404, 'House not found');
    const house = await prisma.house.update({ where: { id: houseId }, data: req.body });
    const changed = Object.keys(req.body).filter(k => before[k] !== req.body[k]);
    await audit(req, 'edit_house', before.leaderId, {
      house: before.name,
      before: Object.fromEntries(changed.map(k => [k, before[k]])),
      after:  Object.fromEntries(changed.map(k => [k, req.body[k]])),
    });
    res.json({ ok: true, house });
  }));

  app.post('/api/admin/houses/:houseId/leader', validate(adminSchemas.houseLeader), h(async (req, res) => {
    const houseId = parseInt(req.params.houseId, 10);
    const house = await prisma.house.findUnique({ where: { id: houseId } });
    if (!house) throw fail(404, 'House not found');
    const member = await prisma.houseMember.findUnique({ where: { userId: req.body.userId } });
    if (!member || member.houseId !== houseId) throw fail(400, 'That player is not a member of this house');
    if (house.leaderId === req.body.userId) throw fail(400, 'That player already leads this house');
    await prisma.$transaction([
      prisma.houseMember.updateMany({ where: { userId: house.leaderId, houseId }, data: { rank: 'Bannerman' } }),
      prisma.house.update({ where: { id: houseId }, data: { leaderId: req.body.userId } }),
      prisma.houseMember.update({ where: { userId: req.body.userId }, data: { rank: 'Lord' } }),
    ]);
    await audit(req, 'transfer_house', req.body.userId, { house: house.name, fromUserId: house.leaderId, toUserId: req.body.userId });
    res.json({ ok: true });
  }));

  app.post('/api/admin/houses/:houseId/disband', h(async (req, res) => {
    const houseId = parseInt(req.params.houseId, 10);
    const house = await prisma.house.findUnique({ where: { id: houseId }, include: { _count: { select: { members: true } } } });
    if (!house) throw fail(404, 'House not found');
    await prisma.$transaction([
      prisma.houseMember.deleteMany({ where: { houseId } }),
      prisma.house.delete({ where: { id: houseId } }),
    ]);
    await audit(req, 'disband_house', house.leaderId, { house: house.name, members: house._count.members, gold: house.gold });
    res.json({ ok: true });
  }));

  // ── Errors ──
  app.get('/api/admin/errors', h(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [total, errors] = await Promise.all([
      prisma.errorLog.count(),
      prisma.errorLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    ]);
    res.json({ total, page, pageSize: PAGE_SIZE, errors });
  }));

  app.post('/api/admin/errors/clear', h(async (req, res) => {
    const { count } = await prisma.errorLog.deleteMany({});
    await audit(req, 'clear_errors', null, { count });
    res.json({ ok: true, count });
  }));

  // ── Feedback ──
  app.get('/api/admin/feedback', h(async (req, res) => {
    const status = String(req.query.status || 'open');
    const where = status === 'all' ? {} : { resolved: status === 'resolved' };
    const feedback = await prisma.feedback.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200,
      include: { user: { select: { id: true, characterName: true, username: true, email: true } } },
    });
    res.json(feedback);
  }));

  app.post('/api/admin/feedback/:fid', validate(adminSchemas.feedback), h(async (req, res) => {
    const fid = parseInt(req.params.fid, 10);
    const fb = await prisma.feedback.update({ where: { id: fid }, data: { resolved: req.body.resolved } });
    await audit(req, req.body.resolved ? 'resolve_feedback' : 'reopen_feedback', fb.userId, { feedbackId: fid });
    res.json({ ok: true });
  }));

  // ── Announcements ──
  app.get('/api/admin/announcements', h(async (req, res) => {
    res.json(await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }));
  }));

  app.post('/api/admin/announcements', validate(adminSchemas.announcement), h(async (req, res) => {
    const { message, hours } = req.body;
    const a = await prisma.announcement.create({
      data: {
        message,
        expiresAt: hours ? new Date(Date.now() + hours * 3600e3) : null,
        createdBy: req.user.characterName || req.user.username,
      },
    });
    await audit(req, 'create_announcement', null, { id: a.id, message, hours: hours || null });
    res.json({ ok: true, announcement: a });
  }));

  app.post('/api/admin/announcements/:aid', validate(adminSchemas.announcementToggle), h(async (req, res) => {
    const aid = parseInt(req.params.aid, 10);
    await prisma.announcement.update({ where: { id: aid }, data: { active: req.body.active } });
    await audit(req, req.body.active ? 'enable_announcement' : 'disable_announcement', null, { id: aid });
    res.json({ ok: true });
  }));

  app.post('/api/admin/announcements/:aid/delete', h(async (req, res) => {
    const aid = parseInt(req.params.aid, 10);
    const a = await prisma.announcement.delete({ where: { id: aid } });
    await audit(req, 'delete_announcement', null, { id: aid, message: a.message });
    res.json({ ok: true });
  }));

  // ── Audit log ──
  app.get('/api/admin/audit', h(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [total, entries] = await Promise.all([
      prisma.adminAuditLog.count(),
      prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    ]);
    res.json({ total, page, pageSize: PAGE_SIZE, entries });
  }));
}

// Logged-in endpoint used by nav.js: active announcements for the banner, plus
// whether to show the Admin link in the sidebar.
function registerAnnouncementRoute(app, { prisma, logError }) {
  app.get('/api/announcements', async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ announcements: [], isAdmin: false });
    try {
      const now = new Date();
      const list = await prisma.announcement.findMany({
        where: { active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, message: true, createdAt: true },
      });
      res.json({ announcements: list, isAdmin: !!req.user.isAdmin });
    } catch (e) {
      logError('/api/announcements error:', e);
      res.json({ announcements: [], isAdmin: !!req.user?.isAdmin });
    }
  });
}

module.exports = {
  installPresence,
  recordLoginEvent,
  persistError,
  isAdminEmail,
  isBanned,
  startBackgroundJobs,
  registerAdminRoutes,
  registerAnnouncementRoute,
};
