// admin-routes.js
// Mount in server.js (after the session/passport middleware and `prisma` exist):
//   require('./admin-routes')(app, prisma, path);
// Roles live in User.role ('player' | 'moderator' | 'admin').
// ADMIN_EMAILS="you@gmail.com" is a bootstrap list: those accounts are always admin.

const EDITABLE = ['level','xp','statPoints','strength','defense','speed','dexterity','intelligence',
  'health','maxHealth','energy','maxEnergy','gold','wagonTier'];

module.exports = function (app, prisma, path, audit = () => {}) {
  // ── Roles & permissions ─────────────────────────────────────────────────────
  // User.role in the database is the source of truth. ADMIN_EMAILS still works as a
  // bootstrap/recovery list: anyone on it is always an admin, so you can never lock yourself out.
  const ROLES = ['player', 'moderator', 'admin'];
  const STAFF = ['moderator', 'admin'];
  const PERMISSIONS = {
    'portal.view':        STAFF,
    'players.view':       STAFF,
    'activity.view':      STAFF,
    'audit.view':         STAFF,
    'items.view':         STAFF,
    'players.release':    STAFF,
    'players.edit_stats': ['admin'],
    'players.grant_item': ['admin'],
    'items.manage':       ['admin'],
    'roles.manage':       ['admin'],
  };

  const admins = () => (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const isBootstrapAdmin = (u) => !!(u && u.email && admins().includes(u.email.toLowerCase()));
  const roleOf = (u) => {
    if (!u) return 'player';
    if (isBootstrapAdmin(u)) return 'admin';
    return ROLES.includes(u.role) ? u.role : 'player';
  };
  const can = (u, perm) => (PERMISSIONS[perm] || []).includes(roleOf(u));

  // 403 "Admins only" = not staff at all (the portal sends these users away).
  // 403 with denied:true = staff, but their role lacks this permission.
  function requirePerm(perm) {
    return (req, res, next) => {
      if (!req.isAuthenticated() || !can(req.user, 'portal.view'))
        return res.status(403).json({ error: 'Admins only' });
      if (!can(req.user, perm))
        return res.status(403).json({ error: 'Your role cannot do that', denied: true });
      next();
    };
  }

  app.get('/admin', (req, res) => {
    if (!req.isAuthenticated() || !can(req.user, 'portal.view')) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });

  // Who am I and what can I do? (lets the portal hide buttons; the server still enforces everything)
  app.get('/api/admin/me', requirePerm('portal.view'), (req, res) => {
    const role = roleOf(req.user);
    res.json({ id: req.user.id, role, permissions: Object.keys(PERMISSIONS).filter(p => PERMISSIONS[p].includes(role)) });
  });

  app.get('/api/admin/overview', requirePerm('portal.view'), async (req, res) => {
    const [users, houses, items, fights, gold, recent] = await Promise.all([
      prisma.user.count(), prisma.house.count(), prisma.item.count(), prisma.combatSession.count(),
      prisma.stats.aggregate({ _sum: { gold: true }, _avg: { level: true } }),
      prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 8,
        select: { id: true, characterName: true, characterClass: true, createdAt: true } }),
    ]);
    res.json({ users, houses, items, activeFights: fights,
      totalGold: gold._sum.gold || 0, avgLevel: Math.round((gold._avg.level || 0) * 10) / 10, recent });
  });

  app.get('/api/admin/players', requirePerm('players.view'), async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const players = await prisma.user.findMany({
      where: q ? { OR: [
        { characterName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ] } : {},
      include: { stats: true }, orderBy: { id: 'desc' }, take: 100,
    });
    res.json(players.map(p => ({ id: p.id, characterName: p.characterName, email: p.email,
      characterClass: p.characterClass, role: roleOf(p), bootstrapAdmin: isBootstrapAdmin(p), createdAt: p.createdAt, lastLoginAt: p.lastLoginAt, stats: p.stats })));
  });

  app.post('/api/admin/players/:id/stats', requirePerm('players.edit_stats'), async (req, res) => {
    const data = {};
    for (const k of EDITABLE) {
      if (req.body[k] === undefined) continue;
      const n = parseInt(req.body[k], 10);
      if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: `Invalid ${k}` });
      data[k] = n;
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      const before = await prisma.stats.findUnique({ where: { userId: +req.params.id } });
      await prisma.stats.update({ where: { userId: +req.params.id }, data });
      const changes = {};
      for (const k of Object.keys(data)) if (before && before[k] !== data[k]) changes[k] = { from: before[k], to: data[k] };
      if (Object.keys(changes).length) audit(req, 'admin.edit_stats', { targetUserId: +req.params.id, metadata: { changes } });
      console.log(`[admin] ${req.user.email} edited stats of user ${req.params.id}`, data);
      res.json({ ok: true });
    } catch (e) { res.status(404).json({ error: 'Player not found' }); }
  });

  app.post('/api/admin/players/:id/release', requirePerm('players.release'), async (req, res) => {
    try {
      const s = await prisma.stats.findUnique({ where: { userId: +req.params.id } });
      await prisma.stats.update({ where: { userId: +req.params.id }, data: {
        inJail: false, jailUntil: null, inHospital: false, hospitalUntil: null,
        health: Math.max(s.health, 1) } });
      await prisma.combatSession.deleteMany({ where: { userId: +req.params.id } });
      audit(req, 'admin.release', { targetUserId: +req.params.id,
        metadata: { wasInJail: s.inJail, wasInHospital: s.inHospital } });
      res.json({ ok: true });
    } catch (e) { res.status(404).json({ error: 'Player not found' }); }
  });

  app.post('/api/admin/players/:id/grant-item', requirePerm('players.grant_item'), async (req, res) => {
    const itemId = parseInt(req.body.itemId, 10), qty = Math.max(1, parseInt(req.body.quantity, 10) || 1);
    const userId = +req.params.id;
    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const inv = await prisma.inventory.findFirst({ where: { userId, itemId } });
    if (inv) await prisma.inventory.update({ where: { id: inv.id }, data: { quantity: { increment: qty } } });
    else await prisma.inventory.create({ data: { userId, itemId, quantity: qty } });
    await prisma.activityLog.create({ data: { userId, category: 'inventory', message: `Received ${qty}x ${item.name} from the Realm Keepers.` } });
    audit(req, 'admin.grant_item', { targetUserId: userId, metadata: { itemId, itemName: item.name, qty } });
    res.json({ ok: true });
  });

  app.get('/api/admin/items', requirePerm('items.view'), async (req, res) => {
    res.json(await prisma.item.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] }));
  });

  app.post('/api/admin/items', requirePerm('items.manage'), async (req, res) => {
    const { name, description, type, effect, basePrice, icon } = req.body;
    if (!name || !type || !(parseInt(basePrice, 10) >= 0)) return res.status(400).json({ error: 'Name, type and price required' });
    const item = await prisma.item.create({ data: { name, description: description || '', type,
      effect: effect || '', basePrice: parseInt(basePrice, 10), ...(icon ? { icon } : {}) } });
    audit(req, 'admin.item_create', { metadata: { itemId: item.id, name: item.name, basePrice: item.basePrice } });
    res.json({ ok: true, item });
  });

  app.put('/api/admin/items/:id', requirePerm('items.manage'), async (req, res) => {
    const { name, description, type, effect, basePrice, icon } = req.body;
    const data = {};
    if (name) data.name = name;
    if (description !== undefined) data.description = description;
    if (type) data.type = type;
    if (effect !== undefined) data.effect = effect;
    if (basePrice !== undefined) data.basePrice = parseInt(basePrice, 10);
    if (icon) data.icon = icon;
    try {
      const item = await prisma.item.update({ where: { id: +req.params.id }, data });
      audit(req, 'admin.item_update', { metadata: { itemId: item.id, fields: data } });
      res.json({ ok: true, item });
    } catch (e) { res.status(404).json({ error: 'Item not found' }); }
  });

  app.get('/api/admin/activity', requirePerm('activity.view'), async (req, res) => {
    const where = req.query.userId ? { userId: +req.query.userId } : {};
    const entries = await prisma.activityLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100,
      include: { user: { select: { characterName: true } } } });
    res.json({ entries });
  });

  // Change a player's role. Admin only, never your own, never the last admin.
  app.post('/api/admin/players/:id/role', requirePerm('roles.manage'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const role = String(req.body.role || '');
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Role must be one of: ' + ROLES.join(', ') });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
    try {
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) return res.status(404).json({ error: 'Player not found' });
      if (isBootstrapAdmin(target)) return res.status(400).json({ error: 'This admin is set in ADMIN_EMAILS; change it there' });
      const from = ROLES.includes(target.role) ? target.role : 'player';
      if (from === role) return res.json({ ok: true, role, unchanged: true });
      if (from === 'admin' && role !== 'admin' && admins().length === 0) {
        const others = await prisma.user.count({ where: { role: 'admin', id: { not: id } } });
        if (others === 0) return res.status(400).json({ error: 'Cannot remove the last admin' });
      }
      await prisma.user.update({ where: { id }, data: { role } });
      audit(req, 'admin.set_role', { targetUserId: id, metadata: { from, to: role } });
      res.json({ ok: true, role });
    } catch (e) { console.error('/api/admin/players/:id/role error:', e); res.status(500).json({ error: 'Something went wrong' }); }
  });

  // Audit trail (who did what, from where). Admin only, same rule as the rest of the portal.
  app.get('/api/admin/audit', requirePerm('audit.view'), async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const and = [];
    const uid = parseInt(req.query.userId, 10);
    if (uid) and.push({ OR: [{ userId: uid }, { targetUserId: uid }] });
    if (req.query.action) and.push({ action: { startsWith: String(req.query.action) } });
    try {
      const rows = await prisma.auditLog.findMany({ where: and.length ? { AND: and } : {},
        orderBy: { createdAt: 'desc' }, take: limit });
      const ids = [...new Set(rows.flatMap(r => [r.userId, r.targetUserId]).filter(Boolean))];
      const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } },
        select: { id: true, characterName: true } }) : [];
      const name = Object.fromEntries(users.map(u => [u.id, u.characterName || '(unnamed)']));
      res.json({ entries: rows.map(r => ({ ...r,
        userName: r.userId ? (name[r.userId] || '(deleted)') : null,
        targetName: r.targetUserId ? (name[r.targetUserId] || '(deleted)') : null })) });
    } catch (e) { console.error('/api/admin/audit error:', e); res.status(500).json({ error: 'Something went wrong' }); }
  });
};
