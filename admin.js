// admin.js — admin panel backend for Clans vs Society.
//
// Exposes:
//   roleOf(user) / can(user, perm)   — roles + permissions (User.role, ADMIN_EMAILS bootstrap)
//   installPresence(app, deps)       — ban enforcement + "last seen" tracking (mount after passport.session)
//   persistError(prisma, args)       — store a logError() call in ErrorLog
//   isBanned(user)
//   startBackgroundJobs(deps)        — hourly gold snapshots + error-log pruning
//   registerAnnouncementRoute(app, deps)
//   registerAdminRoutes(app, deps)   — /admin page + /api/admin/* endpoints
//
// Everything is recorded in AuditLog through server.js's audit(): logins and
// logouts as auth.*, game events as market.* / raid.* / etc., and every admin
// change as admin.* with before/after values.

const path = require('path');
const { z } = require('zod');

const ONLINE_WINDOW_MS      = 5 * 60 * 1000;   // "online now" = seen in last 5 min
const LAST_SEEN_THROTTLE_MS = 60 * 1000;       // write lastSeenAt at most once a minute per player
const SNAPSHOT_INTERVAL_MS  = 60 * 60 * 1000;  // hourly gold snapshots
const SNAPSHOT_KEEP_DAYS    = 14;
const ERROR_KEEP_DAYS       = 30;
const PAGE_SIZE             = 50;

// ─── Roles & permissions ──────────────────────────────────────────────────────
// User.role in the database is the source of truth. ADMIN_EMAILS is a
// bootstrap/recovery list: anyone on it is always an admin, so you can never
// lock yourself out.

const ROLES = ['player', 'moderator', 'admin'];
const STAFF = ['moderator', 'admin'];
const ADMIN = ['admin'];

const PERMISSIONS = {
  // Looking
  'portal.view':          STAFF,
  'players.view':         STAFF,
  'activity.view':        STAFF,
  'audit.view':           STAFF,
  'logins.view':          STAFF,
  'economy.view':         STAFF,
  'market.view':          STAFF,
  'items.view':           STAFF,
  'houses.view':          STAFF,
  'feedback.view':        STAFF,
  'errors.view':          ADMIN,
  // Moderating
  'players.release':      STAFF,   // jail/hospital, stuck travel/fights, cooldowns
  'players.kick':         STAFF,
  'players.ban':          STAFF,
  'market.moderate':      STAFF,
  'houses.moderate':      STAFF,   // rename, motto
  'feedback.manage':      STAFF,
  'announcements.manage': STAFF,
  // Changing the game
  'players.edit_stats':   ADMIN,
  'players.grant_item':   ADMIN,   // give and remove items
  'items.manage':         ADMIN,
  'houses.manage':        ADMIN,   // vault gold, leadership, disband
  'errors.manage':        ADMIN,
  'roles.manage':         ADMIN,
};

function adminEmails() {
  return (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}
const isBootstrapAdmin = u => !!(u && u.email && adminEmails().includes(String(u.email).toLowerCase()));
function roleOf(u) {
  if (!u) return 'player';
  if (isBootstrapAdmin(u)) return 'admin';
  return ROLES.includes(u.role) ? u.role : 'player';
}
const can = (u, perm) => (PERMISSIONS[perm] || []).includes(roleOf(u));
const permissionsFor = role => Object.keys(PERMISSIONS).filter(p => PERMISSIONS[p].includes(role));
const rank = u => ROLES.indexOf(roleOf(u));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isBanned(user, now = Date.now()) {
  return !!(user && user.bannedUntil && new Date(user.bannedUntil).getTime() > now);
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

    if (isBanned(user) && !isBootstrapAdmin(user)) {
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
  'health', 'maxHealth', 'energy', 'maxEnergy', 'wagonTier',
];

const COOLDOWN_FIELDS = [
  'lastStrengthTrain', 'lastDefenseTrain', 'lastSpeedTrain', 'lastDexTrain',
  'lastRaidVillageAt', 'lastRaidCaravanAt', 'lastRaidManorAt', 'lastRaidTreasuryAt',
];

const adminSchemas = {
  stats: z.object(Object.fromEntries(EDITABLE_STATS.map(k => [k, int0().max(1_000_000_000).optional()])))
    .strict()
    .refine(o => Object.keys(o).length > 0, 'No fields to update'),
  giveItem:   z.object({ itemId: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1).max(10000) }),
  removeItem: z.object({ inventoryId: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1).max(10000) }),
  release:    z.object({ what: z.enum(['jail', 'hospital', 'both']) }),
  ban: z.object({
    days:   z.coerce.number().min(0).max(36500).nullable().optional(), // null/0 = permanent
    reason: z.string().trim().max(300).optional(),
  }),
  role: z.object({ role: z.enum(ROLES, { message: 'Role must be one of: ' + ROLES.join(', ') }) }),
  item: z.object({
    name:        z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).default(''),
    type:        z.string().trim().min(1).max(40),
    effect:      z.string().trim().max(200).default(''),
    basePrice:   int0().max(10_000_000),
    icon:        z.string().trim().max(300).optional(),
  }),
  house: z.object({
    name:  z.string().trim().min(2).max(30).optional(),
    motto: z.string().trim().max(100).optional(),
    gold:  int0().max(1_000_000_000).optional(),
  }),
  houseLeader:   z.object({ userId: z.coerce.number().int().positive() }),
  removeListing: z.object({ returnToSeller: z.boolean().default(true) }),
  feedback:      z.object({ resolved: z.boolean() }),
  announcement: z.object({
    message: z.string().trim().min(1).max(500),
    hours:   z.coerce.number().min(0).max(24 * 365).nullable().optional(), // null/0 = until turned off
  }),
  announcementToggle: z.object({ active: z.boolean() }),
};

// Login log event types → AuditLog actions. Kicks and bans are admin actions
// whose subject is the target player, so they're matched on targetUserId.
const LOGIN_TYPES = {
  login:  { action: 'auth.login',  subject: 'userId' },
  logout: { action: 'auth.logout', subject: 'userId' },
  kicked: { action: 'admin.kick',  subject: 'targetUserId' },
  banned: { action: 'admin.ban',   subject: 'targetUserId' },
};
const LOGIN_ACTIONS = Object.values(LOGIN_TYPES).map(t => t.action);

// ─── Routes ───────────────────────────────────────────────────────────────────

function registerAdminRoutes(app, { prisma, logError, validate, CLASSES, audit }) {
  // 403 "Admins only" = not staff at all (the portal sends these users away).
  // 403 with denied:true = staff, but their role lacks this permission.
  function requirePerm(perm) {
    return (req, res, next) => {
      if (!req.isAuthenticated() || !can(req.user, 'portal.view')) return res.status(403).json({ error: 'Admins only' });
      if (!can(req.user, perm)) return res.status(403).json({ error: 'Your role cannot do that', denied: true });
      next();
    };
  }

  // Wraps async handlers so a thrown error becomes a logged 500 instead of a crash.
  const h = fn => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message, ...(e.denied ? { denied: true } : {}) });
      if (e && e.code === 'P2002') return res.status(409).json({ error: 'That name is already taken' });
      if (e && e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      logError(`[admin] ${req.method} ${req.originalUrl} error:`, e);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };

  const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

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

  // Moderators can't kick or ban other staff; nobody can act on an ADMIN_EMAILS admin.
  function assertCanModerate(req, target) {
    if (target.id === req.user.id) throw fail(400, "You can't do that to yourself");
    if (isBootstrapAdmin(target)) throw fail(400, 'This admin is set in ADMIN_EMAILS; change it there');
    if (rank(target) >= rank(req.user) && roleOf(req.user) !== 'admin') {
      throw fail(403, 'Only an admin can do that to another staff member', { denied: true });
    }
  }

  async function kickSessions(id) {
    // connect-pg-simple stores the session as JSON: { passport: { user: <id> } }
    return prisma.$executeRaw`DELETE FROM "session" WHERE sess->'passport'->>'user' = ${String(id)}`;
  }

  // ── Page ──
  app.get('/admin', (req, res) => {
    if (!req.isAuthenticated() || !can(req.user, 'portal.view')) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
  });

  // ── Who am I and what can I do? (lets the portal hide buttons; the server still enforces everything)
  app.get('/api/admin/me', requirePerm('portal.view'), (req, res) => {
    const role = roleOf(req.user);
    res.json({
      id: req.user.id, name: playerName(req.user), role,
      bootstrapAdmin: isBootstrapAdmin(req.user),
      permissions: permissionsFor(role),
    });
  });

  // ── Overview ──
  app.get('/api/admin/overview', requirePerm('portal.view'), h(async (req, res) => {
    const now = Date.now();
    const ago = ms => new Date(now - ms);

    const [
      totalPlayers, onlineNow, active24h, active7d, new24h, new7d,
      classRows, levelAgg, goldAgg, houseGoldAgg, openFeedback, errors24h, bannedCount, activeFights,
      loginRows, recent,
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
      prisma.combatSession.count(),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS logins,
               COUNT(DISTINCT "userId")::int AS players
        FROM "AuditLog"
        WHERE action = 'auth.login' AND "createdAt" >= ${ago(14 * 864e5)}
        GROUP BY 1 ORDER BY 1`,
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' }, take: 8,
        select: { id: true, characterName: true, username: true, characterClass: true, createdAt: true },
      }),
    ]);

    res.json({
      totalPlayers, onlineNow, active24h, active7d, new24h, new7d, bannedCount, activeFights,
      avgLevel: Math.round((levelAgg._avg.level || 0) * 10) / 10,
      maxLevel: levelAgg._max.level || 0,
      playerGold: goldAgg._sum.gold || 0,
      houseGold:  houseGoldAgg._sum.gold || 0,
      openFeedback,
      errors24h: can(req.user, 'errors.view') ? errors24h : null,
      classes: classRows
        .map(r => ({ cls: r.characterClass, label: r.characterClass ? (CLASSES[r.characterClass]?.label || r.characterClass) : 'No class yet', count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      loginsByDay: loginRows,
      recent,
    });
  }));

  // ── Online now ──
  app.get('/api/admin/online', requirePerm('players.view'), h(async (req, res) => {
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
  app.get('/api/admin/players', requirePerm('players.view'), h(async (req, res) => {
    const q      = String(req.query.q || '').trim();
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = String(req.query.filter || 'all');
    const sort   = String(req.query.sort || 'lastSeen');

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
    if (filter === 'staff')  where.AND.push({ OR: [{ role: { in: STAFF } }, { email: { in: adminEmails(), mode: 'insensitive' } }] });
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
          id: true, username: true, characterName: true, email: true, characterClass: true, role: true,
          bannedUntil: true, lastSeenAt: true, lastLoginAt: true, createdAt: true,
          stats: { select: { level: true, gold: true, inJail: true, inHospital: true, currentCityId: true } },
          houseMember: { select: { house: { select: { id: true, name: true } } } },
        },
      }),
    ]);
    res.json({
      total, page, pageSize: PAGE_SIZE,
      players: players.map(p => ({ ...p, role: roleOf(p), bootstrapAdmin: isBootstrapAdmin(p) })),
    });
  }));

  // ── Player detail ──
  app.get('/api/admin/players/:id', requirePerm('players.view'), h(async (req, res) => {
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

    const [activity, logins, adminHistory, events, feedback] = await Promise.all([
      prisma.activityLog.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.auditLog.findMany({ where: { userId: id, action: { in: ['auth.login', 'auth.logout'] } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.auditLog.findMany({ where: { targetUserId: id, action: { startsWith: 'admin.' } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.auditLog.findMany({
        where: { OR: [{ userId: id }, { targetUserId: id }], NOT: [{ action: { startsWith: 'auth.' } }, { action: { startsWith: 'admin.' } }] },
        orderBy: { createdAt: 'desc' }, take: 100,
      }),
      can(req.user, 'feedback.view')
        ? prisma.feedback.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20 })
        : [],
    ]);

    // Names for the admins and other players that appear in the trails.
    const ids = [...new Set([...adminHistory, ...events].flatMap(r => [r.userId, r.targetUserId]).filter(Boolean))];
    const names = ids.length
      ? Object.fromEntries((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, characterName: true, username: true } }))
          .map(u => [u.id, u.characterName || u.username]))
      : {};
    const named = r => ({ ...r, userName: r.userId ? (names[r.userId] || '(deleted)') : null, targetName: r.targetUserId ? (names[r.targetUserId] || '(deleted)') : null });

    // Other accounts that have logged in from any IP this player used.
    const ips = [...new Set((await prisma.auditLog.findMany({
      where: { userId: id, action: 'auth.login', ip: { not: null } }, select: { ip: true }, distinct: ['ip'],
    })).map(r => r.ip))];
    let sharedIp = [];
    if (ips.length) {
      const rows = await prisma.auditLog.findMany({
        where: { action: 'auth.login', ip: { in: ips }, userId: { not: id } },
        distinct: ['userId', 'ip'], select: { ip: true, userId: true },
      });
      const others = rows.length ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map(r => r.userId))] } }, select: { id: true, characterName: true, username: true },
      }) : [];
      const byId = Object.fromEntries(others.map(o => [o.id, o]));
      sharedIp = rows.filter(r => byId[r.userId]).map(r => ({ ip: r.ip, id: r.userId, name: playerName(byId[r.userId]) }));
    }

    const { password, googleId, ...safeUser } = user;
    res.json({
      user: { ...safeUser, role: roleOf(user), bootstrapAdmin: isBootstrapAdmin(user) },
      activity, logins, adminHistory: adminHistory.map(named), events: events.map(named),
      feedback, sharedIp, cooldownFields: COOLDOWN_FIELDS,
    });
  }));

  // ── Player actions ──
  app.post('/api/admin/players/:id/stats', requirePerm('players.edit_stats'), validate(adminSchemas.stats), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    if (!player.stats) throw fail(400, 'Player has no character stats yet');
    const changes = {};
    for (const k of Object.keys(req.body)) {
      if (player.stats[k] !== req.body[k]) changes[k] = { from: player.stats[k], to: req.body[k] };
    }
    const stats = await prisma.stats.update({ where: { userId: id }, data: req.body });
    if (Object.keys(changes).length) {
      audit(req, 'admin.edit_stats', { targetUserId: id, metadata: { player: playerName(player), changes } });
    }
    res.json({ ok: true, stats });
  }));

  app.post('/api/admin/players/:id/give-item', requirePerm('players.grant_item'), validate(adminSchemas.giveItem), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    const { itemId, quantity } = req.body;
    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) throw fail(404, 'Item not found');
    const existing = await prisma.inventory.findFirst({ where: { userId: id, itemId } });
    if (existing) await prisma.inventory.update({ where: { id: existing.id }, data: { quantity: { increment: quantity } } });
    else          await prisma.inventory.create({ data: { userId: id, itemId, quantity } });
    await prisma.activityLog.create({ data: { userId: id, category: 'inventory', message: `Received ${quantity}x ${item.name} from the Realm Keepers.` } });
    audit(req, 'admin.grant_item', { targetUserId: id, metadata: { player: playerName(player), itemId, itemName: item.name, qty: quantity } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/remove-item', requirePerm('players.grant_item'), validate(adminSchemas.removeItem), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    const { inventoryId, quantity } = req.body;
    const inv = await prisma.inventory.findFirst({ where: { id: inventoryId, userId: id }, include: { item: true } });
    if (!inv) throw fail(404, 'Inventory entry not found');
    const removed = Math.min(quantity, inv.quantity);
    if (inv.quantity - removed <= 0) await prisma.inventory.delete({ where: { id: inv.id } });
    else await prisma.inventory.update({ where: { id: inv.id }, data: { quantity: inv.quantity - removed } });
    audit(req, 'admin.remove_item', { targetUserId: id, metadata: { player: playerName(player), itemId: inv.itemId, itemName: inv.item.name, qty: removed } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/release', requirePerm('players.release'), validate(adminSchemas.release), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    const s = player.stats;
    if (!s) throw fail(400, 'Player has no character stats yet');
    const { what } = req.body;
    const data = {};
    if (what === 'jail' || what === 'both')     Object.assign(data, { inJail: false, jailUntil: null });
    if (what === 'hospital' || what === 'both') Object.assign(data, { inHospital: false, hospitalUntil: null, health: Math.max(s.health, 1) });
    await prisma.stats.update({ where: { userId: id }, data });
    audit(req, 'admin.release', { targetUserId: id, metadata: { player: playerName(player), what, wasInJail: s.inJail, wasInHospital: s.inHospital } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/cancel-travel', requirePerm('players.release'), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    if (!player.stats) throw fail(400, 'Player has no character stats yet');
    const fields = ['travelDestinationId', 'travelArrivalAt', 'travelDestination', 'travelStartedAt', 'travelArrivesAt'];
    const before = Object.fromEntries(fields.map(f => [f, player.stats[f]]));
    await prisma.stats.update({ where: { userId: id }, data: Object.fromEntries(fields.map(f => [f, null])) });
    audit(req, 'admin.cancel_travel', { targetUserId: id, metadata: { player: playerName(player), destination: before.travelDestination || before.travelDestinationId } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/clear-combat', requirePerm('players.release'), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    const session = await prisma.combatSession.findUnique({ where: { userId: id } });
    if (!session) throw fail(400, 'No fight in progress');
    await prisma.combatSession.delete({ where: { userId: id } });
    audit(req, 'admin.clear_combat', { targetUserId: id, metadata: { player: playerName(player), monster: session.monsterName, zone: session.zoneId } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/reset-cooldowns', requirePerm('players.release'), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    if (!player.stats) throw fail(400, 'Player has no character stats yet');
    await prisma.stats.update({ where: { userId: id }, data: Object.fromEntries(COOLDOWN_FIELDS.map(f => [f, null])) });
    audit(req, 'admin.reset_cooldowns', { targetUserId: id, metadata: { player: playerName(player) } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/players/:id/kick', requirePerm('players.kick'), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    assertCanModerate(req, player);
    const count = await kickSessions(id);
    lastSeenWrites.delete(id);
    await prisma.user.update({ where: { id }, data: { lastSeenAt: null } });
    audit(req, 'admin.kick', { targetUserId: id, metadata: { player: playerName(player), sessionsEnded: count } });
    res.json({ ok: true, sessionsEnded: count });
  }));

  app.post('/api/admin/players/:id/ban', requirePerm('players.ban'), validate(adminSchemas.ban), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    assertCanModerate(req, player);
    const { days, reason } = req.body;
    const bannedUntil = days ? new Date(Date.now() + days * 864e5) : new Date('9999-12-31T00:00:00Z');
    await prisma.user.update({ where: { id }, data: { bannedUntil, banReason: reason || null } });
    const count = await kickSessions(id);
    lastSeenWrites.delete(id);
    audit(req, 'admin.ban', { targetUserId: id, metadata: { player: playerName(player), days: days || 'permanent', reason: reason || null, sessionsEnded: count } });
    res.json({ ok: true, bannedUntil });
  }));

  app.post('/api/admin/players/:id/unban', requirePerm('players.ban'), h(async (req, res) => {
    const id = userId(req);
    const player = await getPlayer(id);
    await prisma.user.update({ where: { id }, data: { bannedUntil: null, banReason: null } });
    audit(req, 'admin.unban', { targetUserId: id, metadata: { player: playerName(player), wasBannedUntil: player.bannedUntil, reason: player.banReason } });
    res.json({ ok: true });
  }));

  // Change a player's role. Admin only, never your own, never the last admin.
  app.post('/api/admin/players/:id/role', requirePerm('roles.manage'), validate(adminSchemas.role), h(async (req, res) => {
    const id = userId(req);
    const { role } = req.body;
    if (id === req.user.id) throw fail(400, 'You cannot change your own role');
    const target = await getPlayer(id);
    if (isBootstrapAdmin(target)) throw fail(400, 'This admin is set in ADMIN_EMAILS; change it there');
    const from = ROLES.includes(target.role) ? target.role : 'player';
    if (from === role) return res.json({ ok: true, role, unchanged: true });
    if (from === 'admin' && role !== 'admin' && adminEmails().length === 0) {
      const others = await prisma.user.count({ where: { role: 'admin', id: { not: id } } });
      if (others === 0) throw fail(400, 'Cannot remove the last admin');
    }
    await prisma.user.update({ where: { id }, data: { role } });
    audit(req, 'admin.set_role', { targetUserId: id, metadata: { player: playerName(target), from, to: role } });
    res.json({ ok: true, role });
  }));

  // ── Login log (auth.login / auth.logout, plus admin kicks and bans) ──
  app.get('/api/admin/logins', requirePerm('logins.view'), h(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    // Which players are we looking at? (null = everyone)
    let subjects = null;
    const uid = parseInt(req.query.userId, 10);
    if (uid > 0) subjects = [uid];
    if (req.query.q) {
      const q = String(req.query.q).trim();
      const matches = await prisma.user.findMany({
        where: { OR: [{ characterName: { contains: q, mode: 'insensitive' } }, { username: { contains: q, mode: 'insensitive' } }] },
        select: { id: true }, take: 500,
      });
      const ids = matches.map(m => m.id);
      subjects = subjects ? subjects.filter(s => ids.includes(s)) : ids;
    }

    const types = LOGIN_TYPES[req.query.type] ? [req.query.type] : Object.keys(LOGIN_TYPES);
    const and = [{
      OR: types.map(t => {
        const { action, subject } = LOGIN_TYPES[t];
        return subjects ? { action, [subject]: { in: subjects } } : { action };
      }),
    }];
    if (req.query.ip) and.push({ ip: String(req.query.ip) });
    const range = {};
    if (req.query.from) { const d = new Date(req.query.from); if (!isNaN(d)) range.gte = d; }
    if (req.query.to)   { const d = new Date(req.query.to);   if (!isNaN(d)) range.lte = new Date(d.getTime() + 864e5 - 1); }
    if (Object.keys(range).length) and.push({ createdAt: range });
    const where = { AND: and };

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    ]);

    const typeOf = action => Object.keys(LOGIN_TYPES).find(t => LOGIN_TYPES[t].action === action);
    const events = rows.map(r => {
      const type = typeOf(r.action);
      const subjectId = LOGIN_TYPES[type].subject === 'userId' ? r.userId : r.targetUserId;
      return { id: r.id, type, subjectId, byId: type === 'kicked' || type === 'banned' ? r.userId : null,
               ip: type === 'login' || type === 'logout' ? r.ip : null,
               userAgent: type === 'login' || type === 'logout' ? r.userAgent : null,
               createdAt: r.createdAt };
    });

    const nameIds = [...new Set(events.flatMap(e => [e.subjectId, e.byId]).filter(Boolean))];
    const users = nameIds.length ? await prisma.user.findMany({ where: { id: { in: nameIds } }, select: { id: true, characterName: true, username: true } }) : [];
    const byId = Object.fromEntries(users.map(u => [u.id, u]));

    // Estimated session length for each login: time until that player's next
    // logout/kick/ban, or until their last-seen time if they never logged out.
    const loginIds = events.filter(e => e.type === 'login').map(e => e.id);
    let durations = {};
    if (loginIds.length) {
      const rows2 = await prisma.$queryRaw`
        WITH ev AS (
          SELECT id, "createdAt",
                 CASE WHEN action LIKE 'auth.%' THEN "userId" ELSE "targetUserId" END AS subject,
                 CASE WHEN action = 'auth.login' THEN 'login' ELSE 'end' END AS kind
          FROM "AuditLog"
          WHERE action IN ('auth.login', 'auth.logout', 'admin.kick', 'admin.ban')
        ),
        l AS (
          SELECT e.id, e.subject, e."createdAt",
                 COALESCE((SELECT MIN(n."createdAt") FROM ev n
                           WHERE n.subject = e.subject AND n.kind = 'login' AND n."createdAt" > e."createdAt"), 'infinity') AS next_login
          FROM ev e WHERE e.id = ANY(${loginIds})
        )
        SELECT l.id,
               (SELECT MIN(o."createdAt") FROM ev o
                 WHERE o.subject = l.subject AND o.kind = 'end' AND o."createdAt" > l."createdAt" AND o."createdAt" < l.next_login) AS ended_at,
               CASE WHEN u."lastSeenAt" > l."createdAt" AND u."lastSeenAt" < l.next_login THEN u."lastSeenAt" END AS seen_at,
               l."createdAt" AS started_at
        FROM l LEFT JOIN "User" u ON u.id = l.subject`;
      durations = Object.fromEntries(rows2.map(r => {
        const end = r.ended_at || r.seen_at;
        return [r.id, { seconds: end ? Math.round((new Date(end) - new Date(r.started_at)) / 1000) : null, ended: !!r.ended_at }];
      }));
    }

    res.json({
      total, page, pageSize: PAGE_SIZE,
      events: events.map(e => ({
        ...e,
        user: byId[e.subjectId] || { id: e.subjectId, characterName: '(deleted)' },
        by: e.byId ? (byId[e.byId] || { id: e.byId, characterName: '(deleted)' }) : null,
        session: durations[e.id] || null,
      })),
    });
  }));

  // ── Economy ──
  app.get('/api/admin/economy', requirePerm('economy.view'), h(async (req, res) => {
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
  app.get('/api/admin/market', requirePerm('market.view'), h(async (req, res) => {
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

  app.post('/api/admin/market/:listingId/remove', requirePerm('market.moderate'), validate(adminSchemas.removeListing), h(async (req, res) => {
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
    audit(req, 'admin.remove_listing', { targetUserId: listing.sellerId, metadata: {
      listingId, itemName: listing.item.name, qty: listing.quantity, price: listing.price, returnedToSeller: req.body.returnToSeller,
    } });
    res.json({ ok: true });
  }));

  // ── Items ──
  app.get('/api/admin/items', requirePerm('items.view'), h(async (req, res) => {
    const items = await prisma.item.findMany({
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { inventory: true, listings: true } } },
    });
    res.json(items);
  }));

  app.post('/api/admin/items', requirePerm('items.manage'), validate(adminSchemas.item), h(async (req, res) => {
    const data = { ...req.body };
    if (!data.icon) delete data.icon;
    const item = await prisma.item.create({ data });
    audit(req, 'admin.item_create', { metadata: { itemId: item.id, name: item.name, basePrice: item.basePrice } });
    res.json({ ok: true, item });
  }));

  app.post('/api/admin/items/:itemId', requirePerm('items.manage'), validate(adminSchemas.item), h(async (req, res) => {
    const itemId = parseInt(req.params.itemId, 10);
    const before = await prisma.item.findUnique({ where: { id: itemId } });
    if (!before) throw fail(404, 'Item not found');
    const data = { ...req.body };
    if (!data.icon) delete data.icon;
    const item = await prisma.item.update({ where: { id: itemId }, data });
    const changes = {};
    for (const k of Object.keys(data)) if (before[k] !== data[k]) changes[k] = { from: before[k], to: data[k] };
    if (Object.keys(changes).length) audit(req, 'admin.item_update', { metadata: { itemId, name: item.name, changes } });
    res.json({ ok: true, item });
  }));

  // ── Houses ──
  app.get('/api/admin/houses', requirePerm('houses.view'), h(async (req, res) => {
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

  app.post('/api/admin/houses/:houseId', requirePerm('houses.moderate'), validate(adminSchemas.house), h(async (req, res) => {
    const houseId = parseInt(req.params.houseId, 10);
    const before = await prisma.house.findUnique({ where: { id: houseId } });
    if (!before) throw fail(404, 'House not found');
    const data = { ...req.body };
    if (data.gold !== undefined && data.gold !== before.gold && !can(req.user, 'houses.manage')) {
      throw fail(403, 'Only admins can change house gold', { denied: true });
    }
    if (data.gold === before.gold) delete data.gold;
    const house = await prisma.house.update({ where: { id: houseId }, data });
    const changes = {};
    for (const k of Object.keys(data)) if (before[k] !== data[k]) changes[k] = { from: before[k], to: data[k] };
    if (Object.keys(changes).length) audit(req, 'admin.house_update', { targetUserId: before.leaderId, metadata: { houseId, house: before.name, changes } });
    res.json({ ok: true, house });
  }));

  app.post('/api/admin/houses/:houseId/leader', requirePerm('houses.manage'), validate(adminSchemas.houseLeader), h(async (req, res) => {
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
    audit(req, 'admin.house_transfer', { targetUserId: req.body.userId, metadata: { houseId, house: house.name, fromUserId: house.leaderId } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/houses/:houseId/disband', requirePerm('houses.manage'), h(async (req, res) => {
    const houseId = parseInt(req.params.houseId, 10);
    const house = await prisma.house.findUnique({ where: { id: houseId }, include: { _count: { select: { members: true } } } });
    if (!house) throw fail(404, 'House not found');
    await prisma.$transaction([
      prisma.houseMember.deleteMany({ where: { houseId } }),
      prisma.house.delete({ where: { id: houseId } }),
    ]);
    audit(req, 'admin.house_disband', { targetUserId: house.leaderId, metadata: { houseId, house: house.name, members: house._count.members, gold: house.gold } });
    res.json({ ok: true });
  }));

  // ── Errors ──
  app.get('/api/admin/errors', requirePerm('errors.view'), h(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [total, errors] = await Promise.all([
      prisma.errorLog.count(),
      prisma.errorLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    ]);
    res.json({ total, page, pageSize: PAGE_SIZE, errors });
  }));

  app.post('/api/admin/errors/clear', requirePerm('errors.manage'), h(async (req, res) => {
    const { count } = await prisma.errorLog.deleteMany({});
    audit(req, 'admin.clear_errors', { metadata: { count } });
    res.json({ ok: true, count });
  }));

  // ── Feedback ──
  app.get('/api/admin/feedback', requirePerm('feedback.view'), h(async (req, res) => {
    const status = String(req.query.status || 'open');
    const where = status === 'all' ? {} : { resolved: status === 'resolved' };
    const feedback = await prisma.feedback.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200,
      include: { user: { select: { id: true, characterName: true, username: true, email: true } } },
    });
    res.json(feedback);
  }));

  app.post('/api/admin/feedback/:fid', requirePerm('feedback.manage'), validate(adminSchemas.feedback), h(async (req, res) => {
    const fid = parseInt(req.params.fid, 10);
    const fb = await prisma.feedback.update({ where: { id: fid }, data: { resolved: req.body.resolved } });
    audit(req, req.body.resolved ? 'admin.feedback_resolve' : 'admin.feedback_reopen', { targetUserId: fb.userId, metadata: { feedbackId: fid } });
    res.json({ ok: true });
  }));

  // ── Announcements ──
  app.get('/api/admin/announcements', requirePerm('announcements.manage'), h(async (req, res) => {
    res.json(await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }));
  }));

  app.post('/api/admin/announcements', requirePerm('announcements.manage'), validate(adminSchemas.announcement), h(async (req, res) => {
    const { message, hours } = req.body;
    const a = await prisma.announcement.create({
      data: { message, expiresAt: hours ? new Date(Date.now() + hours * 3600e3) : null, createdBy: playerName(req.user) },
    });
    audit(req, 'admin.announcement_create', { metadata: { announcementId: a.id, message, hours: hours || null } });
    res.json({ ok: true, announcement: a });
  }));

  app.post('/api/admin/announcements/:aid', requirePerm('announcements.manage'), validate(adminSchemas.announcementToggle), h(async (req, res) => {
    const aid = parseInt(req.params.aid, 10);
    await prisma.announcement.update({ where: { id: aid }, data: { active: req.body.active } });
    audit(req, req.body.active ? 'admin.announcement_on' : 'admin.announcement_off', { metadata: { announcementId: aid } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/announcements/:aid/delete', requirePerm('announcements.manage'), h(async (req, res) => {
    const aid = parseInt(req.params.aid, 10);
    const a = await prisma.announcement.delete({ where: { id: aid } });
    audit(req, 'admin.announcement_delete', { metadata: { announcementId: aid, message: a.message } });
    res.json({ ok: true });
  }));

  // ── Activity feed (player-facing activity messages) ──
  app.get('/api/admin/activity', requirePerm('activity.view'), h(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const where = {};
    const uid = parseInt(req.query.userId, 10);
    if (uid > 0) where.userId = uid;
    if (req.query.category) where.category = String(req.query.category);
    const [total, entries] = await Promise.all([
      prisma.activityLog.count({ where }),
      prisma.activityLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
        include: { user: { select: { id: true, characterName: true, username: true } } } }),
    ]);
    res.json({ total, page, pageSize: PAGE_SIZE, entries });
  }));

  // ── Audit trail (who did what, from where) ──
  app.get('/api/admin/audit', requirePerm('audit.view'), h(async (req, res) => {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || PAGE_SIZE));
    const and = [];
    const uid = parseInt(req.query.userId, 10);
    if (uid) and.push({ OR: [{ userId: uid }, { targetUserId: uid }] });
    if (req.query.action) and.push({ action: { startsWith: String(req.query.action) } });
    const where = and.length ? { AND: and } : {};
    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    ]);
    const ids = [...new Set(rows.flatMap(r => [r.userId, r.targetUserId]).filter(Boolean))];
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, characterName: true, username: true } }) : [];
    const name = Object.fromEntries(users.map(u => [u.id, u.characterName || u.username || '(unnamed)']));
    res.json({
      total, page, pageSize: limit,
      entries: rows.map(r => ({ ...r,
        userName: r.userId ? (name[r.userId] || '(deleted)') : null,
        targetName: r.targetUserId ? (name[r.targetUserId] || '(deleted)') : null })),
    });
  }));
}

// Logged-in endpoint used by nav.js: active announcements for the banner, plus
// whether to show the Admin link in the sidebar.
function registerAnnouncementRoute(app, { prisma, logError }) {
  app.get('/api/announcements', async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ announcements: [], isStaff: false });
    const isStaff = can(req.user, 'portal.view');
    try {
      const now = new Date();
      const list = await prisma.announcement.findMany({
        where: { active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, message: true, createdAt: true },
      });
      res.json({ announcements: list, isStaff });
    } catch (e) {
      logError('/api/announcements error:', e);
      res.json({ announcements: [], isStaff });
    }
  });
}

module.exports = {
  ROLES,
  PERMISSIONS,
  roleOf,
  can,
  isBootstrapAdmin,
  installPresence,
  persistError,
  isBanned,
  startBackgroundJobs,
  registerAdminRoutes,
  registerAnnouncementRoute,
};
