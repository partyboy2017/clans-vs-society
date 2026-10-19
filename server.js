require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { PrismaClient } = require('@prisma/client');
const admin = require('./admin');

const app = express();
const prisma = new PrismaClient();

// Behind Railway's proxy — needed so req.ip is the player's real IP (login log).
app.set('trust proxy', 1);

// Thin wrapper kept around console.error so error-logging call sites don't
// need to change again once Sentry (or similar) gets added back later.
// Errors are also stored in ErrorLog so they show up on the admin page.
function logError(...args) {
  console.error(...args);
  admin.persistError(prisma, args);
}

// ─── Class definitions ────────────────────────────────────────────────────────
// Each class has:
//   baseStats  — added on top of the schema defaults at character creation
//   perLevel   — extra stat growth on level-up (beyond the flat +20 HP / +10 EN)
//   actionMods — multipliers / bonuses applied in action handlers

const CLASSES = {
  WARRIOR: {
    label: 'Warrior',
    baseStats: { strength: 5, defense: 5, maxHealth: 40, health: 40 },
    perLevel:  { maxHealth: 10, strength: 1 },
    desc: 'Iron-boned and fearless. Strongest blade in open battle.',
  },
  RANGER: {
    label: 'Ranger',
    baseStats: { speed: 5, dexterity: 5, maxEnergy: 20, energy: 20 },
    perLevel:  { speed: 1, dexterity: 1 },
    desc: 'Swift and sure. Tires less quickly than most and outpaces danger with ease.',
  },
  MAGICIAN: {
    label: 'Magician',
    baseStats: { intelligence: 10, maxHealth: -20, health: -20 },
    perLevel:  { intelligence: 1 },
    desc: 'Fragile but devastating. Actions cost 25% less energy.',
  },
  NECROMANCER: {
    label: 'Necromancer',
    baseStats: { intelligence: 5, defense: 5, maxHealth: 20, health: 20 },
    perLevel:  { intelligence: 1, defense: 1 },
    desc: 'Masters death itself. Rises from injury faster and grows stronger through attrition.',
  },
  SHADOWBLADE: {
    label: 'Shadowblade',
    baseStats: { speed: 5, strength: 3, dexterity: 3 },
    perLevel:  { speed: 1, strength: 1 },
    desc: 'Lurks in shadow, unseen until the killing blow lands.',
  },
  CLERIC: {
    label: 'Cleric',
    baseStats: { intelligence: 5, defense: 5, maxHealth: 30, health: 30 },
    perLevel:  { intelligence: 1, defense: 1, maxHealth: 5 },
    desc: 'Blessed by higher powers. Heals for half the gold cost and grows wiser with every trial.',
  },
  BARD: {
    label: 'Bard',
    baseStats: { dexterity: 5, speed: 3, intelligence: 3, maxEnergy: 10, energy: 10 },
    perLevel:  { dexterity: 1, intelligence: 1 },
    desc: 'Words are their weapon. Earns bonus XP everywhere and may charm extra coin from the crowd.',
  },
};

const VALID_CLASSES = Object.keys(CLASSES);

// ─── Input validation ──────────────────────────────────────────────────────────
// Zod schemas guard the *shape* of request bodies (correct types, required
// fields, sane bounds) before a request ever reaches game logic. This turns
// malformed input (missing fields, wrong types, huge strings) into a clean
// 400 with a clear message, instead of a raw Prisma error or a 500. Business
// rules that need a database lookup (e.g. "does this location actually
// exist?") stay in the route handler — that's not something a shape
// validator can check on its own.

const { z } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Invalid request' });
    }
    req.body = result.data;
    next();
  };
}

// Letters (any language, so accented names work), digits, spaces and - _ .
// Anything else, notably < > " ' &, is rejected: names are shown all over the
// UI, and an apostrophe would also break the Raids page's onclick handlers.
const CHARACTER_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

// ─── Market rules ─────────────────────────────────────────────────────────────
// Listing an item costs 10% of the asking price up front (rounded up, at least
// 1 gold). The fee is not refunded. A listing stays up for 4 days; after that
// it comes down and the items go back to the seller's inventory.
const MARKET_LISTING_FEE_RATE = 0.10;
const MARKET_LISTING_DAYS     = 4;
const MARKET_LISTING_MS       = MARKET_LISTING_DAYS * 24 * 60 * 60 * 1000;
const MARKET_MAX_PRICE        = 1_000_000;
const listingFee = price => Math.max(1, Math.ceil(price * MARKET_LISTING_FEE_RATE));

const id = () => z.coerce.number().int().positive('Must be a positive number');

const schemas = {
  chooseName: z.object({
    characterName: z.string().trim()
      .transform(s => s.replace(/\s+/g, ' '))   // collapse runs of spaces
      .pipe(z.string()
        .min(2, 'Name must be at least 2 characters')
        .max(24, 'Name must be 24 characters or fewer')
        .regex(CHARACTER_NAME_RE, 'Names can use letters, numbers, spaces, and - _ .')),
  }),
  chooseClass: z.object({
    characterClass: z.enum(VALID_CLASSES, { message: 'Invalid class' }),
  }),
  skillKey: z.object({
    skillKey: z.string().min(1, 'skillKey is required'),
  }),
  spendStat: z.object({
    stat: z.enum(['strength', 'defense', 'speed', 'dexterity', 'intelligence'], { message: 'Invalid stat' }),
  }),
  houseCreate: z.object({
    name:  z.string().trim().transform(v => v.replace(/\s+/g, ' ')).pipe(z.string()
      .min(2, 'House name must be at least 2 characters').max(30, 'House name must be 30 characters or fewer')
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, 'House names can use letters, numbers, spaces, and - _ .')),
    motto: z.string().trim().max(100, 'Motto must be 100 characters or fewer')
      .regex(/^[^<>]*$/, 'Mottos cannot contain < or >').optional(),
  }),
  houseJoin: z.object({
    houseId: id(),
  }),
  marketBuy: z.object({
    listingId: id(),
  }),
  marketList: z.object({
    inventoryId: id(),
    price:       z.coerce.number().int().min(1, 'Price must be at least 1 gold')
                   .max(MARKET_MAX_PRICE, `Price can be at most ${MARKET_MAX_PRICE.toLocaleString('en-US')} gold`),
    quantity:    z.coerce.number().int().min(1, 'Quantity must be at least 1').max(9999),
  }),
  inventoryId: z.object({
    inventoryId: id(),
  }),
  shopBuy: z.object({
    itemId:   id(),
    quantity: z.coerce.number().int().min(1).max(99).optional().default(1),
  }),
  inventorySell: z.object({
    inventoryId: id(),
    quantity:    z.coerce.number().int().min(1).optional().default(1),
  }),
  trainingTrain: z.object({
    stat: z.string().min(1, 'stat is required'),
  }),
  raidNpc: z.object({
    locationId: z.string().min(1, 'locationId is required'),
  }),
  raidPlayer: z.object({
    targetId: id(),
  }),
  feedback: z.object({
    category: z.enum(['Bug Report', 'Feedback', 'Other'], { message: 'Invalid category' }),
    message:  z.string().trim()
      .min(5, 'Please write a bit more detail (at least 5 characters).')
      .max(3000, 'Message is too long (max 3000 characters).'),
  }),
  travelStart: z.object({
    cityId: z.string().min(1, 'cityId is required').max(40),
  }),
  monstersStart: z.object({
    zoneId: z.string().min(1, 'zoneId is required'),
  }),
  monstersTurn: z.object({
    action: z.enum(['attack', 'defend', 'flee'], { message: 'Invalid action' }),
  }),
};

// ─── Skill trees ──────────────────────────────────────────────────────────────
// Each skill has:
//   cost      — stat points required to unlock
//   requires  — skillKey that must be unlocked first (null for tier 1)
//   type      — 'passive' | 'active'
//   desc      — shown in the UI
//   onUnlock  — stat deltas applied immediately when a passive is unlocked

const SKILL_TREES = {
  WARRIOR: [
    {
      key:      'WARRIOR_1',
      name:     'Iron Hide',
      cost:     2,
      requires: null,
      type:     'passive',
      desc:     'Your skin thickens like hammered plate. +10 max HP.',
      onUnlock: { maxHealth: 10, health: 10 },
    },
    {
      key:      'WARRIOR_2',
      name:     'Shield Bash',
      cost:     4,
      requires: 'WARRIOR_1',
      type:     'active',
      desc:     'Slam your shield into the enemy for 15 damage and a brief stun. Costs 15 energy.',
    },
    {
      key:      'WARRIOR_3',
      name:     'Warlord',
      cost:     6,
      requires: 'WARRIOR_2',
      type:     'passive',
      desc:     'Your reputation precedes you. +3 Strength.',
      onUnlock: { strength: 3 },
    },
  ],

  RANGER: [
    {
      key:      'RANGER_1',
      name:     'Keen Eye',
      cost:     2,
      requires: null,
      type:     'passive',
      desc:     'You read the land before you move. +2 dexterity.',
      onUnlock: { dexterity: 2 },
    },
    {
      key:      'RANGER_2',
      name:     'Ambush',
      cost:     4,
      requires: 'RANGER_1',
      type:     'active',
      desc:     'Strike from the shadows for high damage before they see you coming. Costs 18 energy.',
    },
    {
      key:      'RANGER_3',
      name:     'Pathfinder',
      cost:     6,
      requires: 'RANGER_2',
      type:     'passive',
      desc:     'You know every shortcut. +3 Speed.',
      onUnlock: { speed: 3 },
    },
  ],

  MAGICIAN: [
    {
      key:      'MAGICIAN_1',
      name:     'Arcane Mind',
      cost:     2,
      requires: null,
      type:     'passive',
      desc:     'Your mind bends further than most dare. +3 intelligence.',
      onUnlock: { intelligence: 3 },
    },
    {
      key:      'MAGICIAN_2',
      name:     'Fireball',
      cost:     4,
      requires: 'MAGICIAN_1',
      type:     'active',
      desc:     'Hurl a ball of flame for massive damage at a fraction of the energy cost. Costs 12 energy.',
    },
    {
      key:      'MAGICIAN_3',
      name:     'Mana Surge',
      cost:     6,
      requires: 'MAGICIAN_2',
      type:     'passive',
      desc:     'Magic flows through you unbidden. 20% chance any action costs 0 energy.',
    },
  ],

  NECROMANCER: [
    {
      key:      'NECROMANCER_1',
      name:     "Death's Embrace",
      cost:     2,
      requires: null,
      type:     'passive',
      desc:     'You have stared into the void and it blinked first. +15 max HP.',
      onUnlock: { maxHealth: 15, health: 15 },
    },
    {
      key:      'NECROMANCER_2',
      name:     'Soul Drain',
      cost:     4,
      requires: 'NECROMANCER_1',
      type:     'active',
      desc:     'Siphon the life force of an enemy, healing yourself for 25 HP. Costs 20 energy.',
    },
    {
      key:      'NECROMANCER_3',
      name:     'Undying',
      cost:     6,
      requires: 'NECROMANCER_2',
      type:     'passive',
      desc:     'Once per rest, death is merely an inconvenience. Revive with 30 HP instead of dying.',
    },
  ],

  SHADOWBLADE: [
    {
      key:      'SHADOWBLADE_1',
      name:     'Knife in the Dark',
      cost:     2,
      requires: null,
      type:     'passive',
      desc:     'You move before they breathe. +2 speed, +2 dexterity.',
      onUnlock: { speed: 2, dexterity: 2 },
    },
    {
      key:      'SHADOWBLADE_2',
      name:     'Backstab',
      cost:     4,
      requires: 'SHADOWBLADE_1',
      type:     'active',
      desc:     'A critical strike to the spine. Deals double gold as a damage bonus if it kills. Costs 15 energy.',
    },
    {
      key:      'SHADOWBLADE_3',
      name:     'Vanish',
      cost:     6,
      requires: 'SHADOWBLADE_2',
      type:     'passive',
      desc:     'You were never really there. 25% chance to dodge all incoming damage.',
    },
  ],

  CLERIC: [
    {
      key:      'CLERIC_1',
      name:     'Divine Ward',
      cost:     2,
      requires: null,
      type:     'passive',
      desc:     'A blessed barrier surrounds you. +10 max HP, +2 defense.',
      onUnlock: { maxHealth: 10, health: 10, defense: 2 },
    },
    {
      key:      'CLERIC_2',
      name:     'Holy Light',
      cost:     4,
      requires: 'CLERIC_1',
      type:     'active',
      desc:     'Channel divine energy to restore 40 HP to yourself. Costs 20 energy.',
    },
    {
      key:      'CLERIC_3',
      name:     'Blessing',
      cost:     6,
      requires: 'CLERIC_2',
      type:     'passive',
      desc:     'The gods favour you when you sleep. Resting restores an extra 20 HP.',
    },
  ],

  BARD: [
    {
      key:      'BARD_1',
      name:     'Silver Tongue',
      cost:     2,
      requires: null,
      type:     'passive',
      desc:     'Every tale earns a lesson. +10% XP from all actions.',
    },
    {
      key:      'BARD_2',
      name:     'Ballad of Greed',
      cost:     4,
      requires: 'BARD_1',
      type:     'active',
      desc:     'Sing a song so compelling the crowd empties their pockets. Guaranteed charm bonus gold. Costs 10 energy.',
    },
    {
      key:      'BARD_3',
      name:     'Legend',
      cost:     6,
      requires: 'BARD_2',
      type:     'passive',
      desc:     'Songs are sung of you in every tavern. +3 to all stats.',
      onUnlock: { strength: 3, defense: 3, speed: 3, dexterity: 3, intelligence: 3 },
    },
  ],
};

// ─── Economy / cooldown constants ─────────────────────────────────────────────────

// Passive energy regeneration — calculated lazily on every action.
// lastEnergyAt on Stats tracks when energy was last ticked forward.
const ENERGY_REGEN_AMOUNT      = 5;               // energy per tick
const ENERGY_REGEN_INTERVAL_MS = 5 * 60 * 1000;  // tick every 5 minutes

// Rest only restores health now — energy comes from passive regen above.
// Short cooldown prevents spamming the inn for free healing.
const REST_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Minimum gap between raids on the *same* NPC location.
const RAID_LOCATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per location

// ─── Helper: find a skill definition by its key across all trees ──────────────
function getSkillByKey(key) {
  for (const tree of Object.values(SKILL_TREES)) {
    const found = tree.find(s => s.key === key);
    if (found) return found;
  }
  return null;
}

// Helper: check if a user has a specific skill unlocked
async function hasSkill(userId, skillKey) {
  const row = await prisma.userSkill.findUnique({
    where: { userId_skillKey: { userId, skillKey } },
  });
  return !!row;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());

// Every game page is served by a guarded route below (/training, /raids, …)
// that checks sign-in and character creation. express.static would also serve
// the same files as /training.html etc., skipping those checks, so send any
// raw page URL to its clean route instead (keeping the query string).
app.get(/^\/([a-z-]+)\.html$/, (req, res) => {
  const page = req.params[0];
  const query = req.originalUrl.slice(req.path.length);
  const target = page === 'index' ? '/' : page === 'city' ? '/realm-map' : `/${page}`;
  res.redirect(target + query);
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));
app.use(passport.initialize());
app.use(passport.session());
// Kicks out banned players and keeps User.lastSeenAt fresh ("online now").
admin.installPresence(app, { prisma });

// A Google sign-in creates the User right away, but Stats (gold, health,
// energy…) only exist once a class is chosen. Until then, game APIs answer
// with a clear 400 instead of crashing on the missing Stats row. Signed-out
// requests fall through to each route's own 401.
const PRE_CHARACTER_API = new Set([
  '/me', '/classes', '/choose-name', '/choose-class', '/logout', '/announcements',
]);
app.use('/api', (req, res, next) => {
  if (!req.isAuthenticated()) return next();
  if (PRE_CHARACTER_API.has(req.path) || req.path.startsWith('/admin')) return next();
  if (req.user.characterName && req.user.characterClass && req.user.stats) return next();
  res.status(400).json({ error: 'Finish creating your character first.', needsCharacter: true });
});

// ─── Coming soon ──────────────────────────────────────────────────────────────
// Sections that aren't open to players yet. Their pages send players back to
// the dashboard and their APIs refuse, so typing the URL doesn't get around
// the "SOON" badge in the sidebar. Admins can still use them for testing.
// To open one up, take it out of this list (or set LOCKED_FEATURES in the
// environment, e.g. LOCKED_FEATURES=achievements).
const LOCKED_FEATURES = new Set(
  (process.env.LOCKED_FEATURES ?? 'house,market,achievements')
    .split(',').map(f => f.trim()).filter(Boolean)
);
const FEATURE_PAGES = { '/house': 'house', '/market': 'market', '/achievements': 'achievements' };
function lockedFeatureForApi(p) {
  if (p === '/house' || p.startsWith('/house/') || p === '/houses') return 'house';
  if (p.startsWith('/market/')) return 'market';
  return null;
}
const featureLocked = (req, feature) => feature && LOCKED_FEATURES.has(feature) && !req.user?.isAdmin;

app.use((req, res, next) => {
  if (req.method !== 'GET' || !featureLocked(req, FEATURE_PAGES[req.path])) return next();
  res.redirect('/dashboard');
});
app.use('/api', (req, res, next) => {
  if (!req.isAuthenticated() || !featureLocked(req, lockedFeatureForApi(req.path))) return next();
  res.status(403).json({ error: 'This part of the realm opens soon.', comingSoon: true });
});

// ─── On the road ──────────────────────────────────────────────────────────────
// While a lord is traveling, the journey is all they get: every game page
// sends them to the traveling screen, and game actions are refused until they
// arrive or turn back. A journey whose arrival time has passed is settled
// first (settleTravel), so arriving players are never caught by this.
// Still open on the road: the traveling page itself, logging out, sending
// feedback, the admin panel, and every read-only API call (the traveling page
// needs /api/me and /api/travel/status).
const TRAVEL_BLOCKED_PAGES = new Set([
  '/dashboard', '/training', '/skills', '/raids', '/monsters', '/store', '/inventory',
  '/wiki', '/realm-map', '/house', '/market', '/achievements',
]);
const TRAVEL_ALLOWED_ACTIONS = new Set(['/travel/start', '/travel/cancel', '/logout', '/feedback']);

async function travelingTo(req) {
  if (!req.isAuthenticated() || !req.user.characterClass) return null;
  await settleTravel(req.user.id);
  const s = await prisma.stats.findUnique({ where: { userId: req.user.id }, select: { travelDestination: true } });
  return s?.travelDestination || null;
}

app.use(async (req, res, next) => {
  if (req.method !== 'GET' || !(TRAVEL_BLOCKED_PAGES.has(req.path) || req.path.startsWith('/city/'))) return next();
  try {
    const dest = await travelingTo(req);
    if (!dest) return next();
    res.redirect(`/traveling?to=${encodeURIComponent(dest)}`);
  } catch (e) { next(e); }
});

app.use('/api', async (req, res, next) => {
  if (req.method === 'GET' || TRAVEL_ALLOWED_ACTIONS.has(req.path) || req.path.startsWith('/admin')) return next();
  try {
    const dest = await travelingTo(req);
    if (!dest) return next();
    res.status(400).json({ error: `You are on the road to ${placeName(dest === HOME_ID ? null : dest)}. Arrive or turn back first.`, traveling: true, travelDestination: dest });
  } catch (e) { next(e); }
});

// ─── In a remote city ─────────────────────────────────────────────────────────
// Aurelia's own pages belong to Aurelia. While a lord is in another city they
// get that city's page (with its local shop), the Realm Map to travel on, and
// their Inventory, Skills, Wiki and Feedback; everything else sends them back
// to the city they're in, and the actions behind those pages are refused.
// The city's shop only sells that city's goods.
const AURELIA_ONLY_PAGES = new Set([
  '/dashboard', '/training', '/raids', '/monsters', '/store', '/house', '/market', '/achievements',
]);
const AURELIA_ONLY_ACTIONS = [
  '/training/train', '/action/rest', '/action/skill',
  '/raid/npc', '/raid/player', '/monsters/start', '/monsters/turn',
];
const isAureliaOnlyAction = p => AURELIA_ONLY_ACTIONS.includes(p) || p.startsWith('/house') || p.startsWith('/market/');

// The remote city a player is standing in right now, or null in Aurelia /
// on the road / without a character.
async function remoteCityOf(req) {
  if (!req.isAuthenticated() || !req.user.characterClass) return null;
  const s = await prisma.stats.findUnique({ where: { userId: req.user.id }, select: { currentCityId: true, travelDestination: true } });
  return s && !s.travelDestination ? (s.currentCityId || null) : null;
}

app.use(async (req, res, next) => {
  if (req.method !== 'GET' || !AURELIA_ONLY_PAGES.has(req.path)) return next();
  try {
    const city = await remoteCityOf(req);
    if (!city) return next();
    res.redirect(`/city/${encodeURIComponent(city)}`);
  } catch (e) { next(e); }
});

app.use('/api', async (req, res, next) => {
  if (req.method === 'GET') return next();
  const aureliaOnly = isAureliaOnlyAction(req.path);
  if (!aureliaOnly && req.path !== '/shop/buy') return next();
  try {
    const city = await remoteCityOf(req);
    if (!city) return next();
    const name = placeName(city);
    if (aureliaOnly) return res.status(400).json({ error: `That can only be done in Aurelia. You are in ${name}.`, inCity: city });
    // Shopping in a city: only that city's own goods.
    const itemId = parseInt(req.body?.itemId, 10);
    const item = Number.isInteger(itemId) ? await prisma.item.findUnique({ where: { id: itemId }, select: { name: true } }) : null;
    const cityDef = CITIES.find(c => c.id === city);
    if (item && cityDef && !cityDef.shopItemNames.includes(item.name)) {
      return res.status(400).json({ error: `${name}'s market doesn't sell ${item.name}.`, inCity: city });
    }
    next();
  } catch (e) { next(e); }
});

// ─── Email ────────────────────────────────────────────────────────────────────

// Railway blocks outbound SMTP on Free/Trial/Hobby plans, so we send email
// via Resend's HTTPS API instead of SMTP (HTTPS traffic is never blocked).
// If RESEND_API_KEY isn't set, sending is silently skipped rather than
// crashing the app.
const APP_URL = process.env.APP_URL || 'https://clans-vs-society-production.up.railway.app';

async function sendWelcomeEmail(toEmail, username) {
  if (!process.env.RESEND_API_KEY || !toEmail) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    process.env.FROM_EMAIL || 'Clans vs Society <onboarding@resend.dev>',
        to:      toEmail,
        subject: `Welcome to Clans vs Society, ${username}!`,
        html:    welcomeEmailHtml(username),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logError('Resend API error:', res.status, body);
      return;
    }
    console.log(`Welcome email sent to ${toEmail}`);
  } catch (err) {
    logError('Failed to send welcome email:', err);
  }
}

async function sendFeedbackEmail({ category, message, username, email }) {
  const dest = process.env.FEEDBACK_EMAIL || 'clansvssociety@gmail.com';
  if (!process.env.RESEND_API_KEY) return { ok: false, error: 'Email is not configured' };

  const html = `
    <div style="background:#1C1A17;padding:24px;font-family:Georgia,serif;">
      <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#25211C;border:1px solid rgba(176,141,69,0.3);">
        <tr><td style="padding:28px 30px;">
          <div style="font-family:Georgia,serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#B08D45;margin-bottom:6px;">Clans vs Society — ${category}</div>
          <h2 style="color:#DCCEA6;font-size:18px;margin:0 0 16px;">New ${category} submitted</h2>
          <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:16px;">
            <tr><td style="color:#93897A;font-size:13px;padding:4px 0;">From:</td><td style="color:#ECE4D2;font-size:13px;padding:4px 0;">${username} (${email || 'no email on file'})</td></tr>
          </table>
          <div style="background:#2C2620;border:1px solid rgba(176,141,69,0.2);padding:16px;color:#ECE4D2;font-size:14px;line-height:1.6;white-space:pre-wrap;">${message}</div>
        </td></tr>
      </table>
    </div>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    process.env.FROM_EMAIL || 'Clans vs Society <onboarding@resend.dev>',
        to:      dest,
        reply_to: email || undefined,
        subject: `[${category}] from ${username}`,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logError('Resend API error (feedback):', res.status, body);
      return { ok: false, error: 'Failed to send' };
    }
    return { ok: true };
  } catch (err) {
    logError('Failed to send feedback email:', err);
    return { ok: false, error: 'Failed to send' };
  }
}

function welcomeEmailHtml(username) {
  return `
  <div style="background:#1C1A17;padding:32px 16px;font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;border-collapse:collapse;">
      <tr>
        <td style="background:#25211C;border:1px solid rgba(176,141,69,0.3);padding:36px 32px;">
          <div style="text-align:center;margin-bottom:24px;">
            <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:2px;text-transform:uppercase;color:#ECE4D2;font-weight:bold;">Clans vs Society</div>
          </div>
          <h1 style="color:#DCCEA6;font-size:22px;text-align:center;margin:0 0 8px;">Welcome, ${username}!</h1>
          <p style="color:#93897A;font-style:italic;text-align:center;font-size:15px;margin:0 0 28px;">Your name has been entered into the annals of the realm.</p>

          <p style="color:#ECE4D2;font-size:15px;line-height:1.6;margin:0 0 20px;">
            The realm is unforgiving, but fortune favors the bold. Here's how to get started:
          </p>

          <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:24px;">
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid rgba(176,141,69,0.15);color:#ECE4D2;font-size:14px;">
                <strong style="color:#B08D45;">Train</strong> — build strength, defense, speed, and dexterity.
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid rgba(176,141,69,0.15);color:#ECE4D2;font-size:14px;">
                <strong style="color:#B08D45;">Raid</strong> — strike NPC locations or rival lords for gold.
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid rgba(176,141,69,0.15);color:#ECE4D2;font-size:14px;">
                <strong style="color:#B08D45;">Fight Monsters</strong> — battle creatures across four tiers of danger.
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#ECE4D2;font-size:14px;">
                <strong style="color:#B08D45;">Rest at the Inn</strong> — spend gold to fully restore health and energy.
              </td>
            </tr>
          </table>

          <div style="text-align:center;">
            <a href="${APP_URL}/dashboard" style="display:inline-block;background:#8B3A2A;color:#ECE4D2;text-decoration:none;padding:12px 32px;font-family:'Courier New',monospace;font-size:13px;letter-spacing:1px;text-transform:uppercase;">
              Enter the Realm
            </a>
          </div>

          <p style="color:#93897A;font-size:12px;text-align:center;margin:28px 0 0;font-style:italic;">
            May your blade stay sharp and your coffers stay full.
          </p>
        </td>
      </tr>
    </table>
  </div>`;
}

// ─── Passport ─────────────────────────────────────────────────────────────────

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.CALLBACK_URL || '/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const existing = await prisma.user.findUnique({ where: { googleId: profile.id } });
    const isNewUser = !existing;

    // Banned players can't log back in until the ban expires.
    if (existing && admin.isBanned(existing)) return done(null, false);

    // ADMIN_EMAILS (comma-separated) bootstraps admin access on login.
    const email   = profile.emails?.[0]?.value || null;
    const grantAdmin = admin.isAdminEmail(email) ? { isAdmin: true } : {};

    const user = await prisma.user.upsert({
      where:  { googleId: profile.id },
      update: {
        ...grantAdmin,
        lastLoginAt: new Date(),
        lastSeenAt:  new Date(),
        avatar:      profile.photos?.[0]?.value || null,
        googleName:  profile.displayName         || null,
        email:       profile.emails?.[0]?.value  || null,
      },
      create: {
        ...grantAdmin,
        lastLoginAt: new Date(),
        lastSeenAt:  new Date(),
        googleId:   profile.id,
        username:   profile.displayName,
        googleName: profile.displayName         || null,
        email:      profile.emails?.[0]?.value  || null,
        avatar:     profile.photos?.[0]?.value  || null,
      },
    });

    if (isNewUser && user.email) {
      // Fire-and-forget — a slow or failing mail provider should never block login.
      sendWelcomeEmail(user.email, user.username).catch(err =>
        logError('Welcome email error:', err)
      );
    }

    done(null, user);
  } catch (err) {
    done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({
      where:   { id },
      include: { stats: true },
    });
    done(null, user);
  } catch (err) {
    logError('[deserializeUser] error for id', id, err);
    done(err, null);
  }
});

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?banned=1' }),
  (req, res) => {
    admin.recordLoginEvent(prisma, req, req.user.id, 'login');
    if (!req.user.characterName)  return res.redirect('/choose-name');
    if (!req.user.characterClass) return res.redirect('/choose-class');
    res.redirect('/dashboard');
  }
);

// ─── Page routes ──────────────────────────────────────────────────────────────

app.get('/dashboard', (req, res) => {
  if (!req.isAuthenticated())    return res.redirect('/');
  if (!req.user.characterName)   return res.redirect('/choose-name');
  if (!req.user.characterClass)  return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/choose-name', (req, res) => {
  if (!req.isAuthenticated())  return res.redirect('/');
  if (req.user.characterName)  return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'choose-name.html'));
});

app.get('/choose-class', (req, res) => {
  if (!req.isAuthenticated())    return res.redirect('/');
  if (!req.user.characterName)   return res.redirect('/choose-name');
  if (req.user.characterClass)   return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'choose-class.html'));
});

app.get('/logout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logout.html'));
});

app.get('/training', (req, res) => {
  if (!req.isAuthenticated())    return res.redirect('/');
  if (!req.user.characterName)   return res.redirect('/choose-name');
  if (!req.user.characterClass)  return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'training.html'));
});

app.get('/skills', (req, res) => {
  if (!req.isAuthenticated())    return res.redirect('/');
  if (!req.user.characterName)   return res.redirect('/choose-name');
  if (!req.user.characterClass)  return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'skills.html'));
});
app.get('/raids', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'raids.html'));
});

// These two pages used to be reachable only as raw .html files.
for (const page of ['traveling', 'achievements']) {
  app.get(`/${page}`, (req, res) => {
    if (!req.isAuthenticated())   return res.redirect('/');
    if (!req.user.characterName)  return res.redirect('/choose-name');
    if (!req.user.characterClass) return res.redirect('/choose-class');
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
}

app.get('/monsters', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'monsters.html'));
});

app.get('/store', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'store.html'));
});

app.get('/inventory', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'inventory.html'));
});

app.get('/wiki', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'wiki.html'));
});

app.get('/realm-map', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'realm-map.html'));
});

app.get('/house', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'house.html'));
});

app.get('/feedback', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'feedback.html'));
});

app.get('/market', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'market.html'));
});

app.get('/city/:cityId', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  if (!CITIES.find(c => c.id === req.params.cityId)) return res.redirect('/realm-map');
  res.sendFile(path.join(__dirname, 'public', 'city.html'));
});
// ─── API: auth ────────────────────────────────────────────────────────────────

app.post('/api/logout', (req, res) => {
  if (req.user) admin.recordLoginEvent(prisma, req, req.user.id, 'logout');
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });
});

// ─── API: player data ─────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });

  // Apply any pending passive regen so the numbers and timers are current.
  let stats = req.user.stats;
  if (stats) {
    try {
      // checkStatus settles finished journeys, applies energy regen and clears
      // expired jail/hospital timers.
      stats = await checkStatus(req.user.id);
    } catch (err) {
      logError('[api/me] status refresh failed', err);
    }
  }

  const now        = Date.now();
  const lastRestAt = stats?.lastRestAt;

  const restCooldownMs = lastRestAt
    ? Math.max(0, new Date(lastRestAt).getTime() + REST_COOLDOWN_MS - now)
    : 0;

  // How long until the next energy tick and until energy is full (for UI countdowns)
  const { nextTickMs, fullMs } = energyTimers(stats, now);

  res.json({
    username:        req.user.characterName || req.user.username,
    googleName:      req.user.googleName,
    email:           req.user.email,
    avatar:          req.user.avatar,
    characterClass:  req.user.characterClass,
    classLabel:      req.user.characterClass ? CLASSES[req.user.characterClass].label : null,
    location:        stats && !stats.travelDestination && stats.currentCityId
                       ? { cityId: stats.currentCityId, name: placeName(stats.currentCityId) } : null,
    lastLoginAt:     req.user.lastLoginAt,
    createdAt:       req.user.createdAt,
    isAdmin:         !!req.user.isAdmin,
    stats,
    restCooldownMs,
    energyRegen: {
      amount:       ENERGY_REGEN_AMOUNT,
      intervalMs:   ENERGY_REGEN_INTERVAL_MS,
      nextTickMs,
      fullMs,
    },
  });
});

// Returns class list — used by choose-class.html
app.get('/api/classes', (req, res) => {
  const list = VALID_CLASSES.map(key => ({
    key,
    label:     CLASSES[key].label,
    desc:      CLASSES[key].desc,
    baseStats: CLASSES[key].baseStats,
  }));
  res.json(list);
});

// ─── API: choose name ─────────────────────────────────────────────────────────

app.post('/api/choose-name', validate(schemas.chooseName), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  // A name is chosen once, at character creation. There is no rename yet.
  if (req.user.characterName) return res.status(409).json({ error: 'Your name is already set' });
  const clean = req.body.characterName;
  try {
    // Names are unique regardless of case ("Bob" blocks "bob"). The advisory
    // lock serializes concurrent claims of the same name, so two sign-ups
    // can't both pass the check and save the same name.
    const taken = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(lower(${clean})))`;
      const exists = await tx.user.findFirst({
        where: { characterName: { equals: clean, mode: 'insensitive' } },
        select: { id: true },
      });
      if (exists) return true;
      const updated = await tx.user.updateMany({
        where: { id: req.user.id, characterName: null },
        data:  { characterName: clean },
      });
      if (updated.count === 0) throw Object.assign(new Error('already named'), { code: 'ALREADY_NAMED' });
      return false;
    });
    if (taken) return res.status(409).json({ error: 'That name is already taken' });

    // Refresh session so the new characterName is visible immediately.
    const updatedUser = await prisma.user.findUnique({
      where:   { id: req.user.id },
      include: { stats: true },
    });
    req.login(updatedUser, (err) => {
      if (err) return res.status(500).json({ error: 'Session refresh failed' });
      res.json({ ok: true, characterName: clean });
    });
  } catch (e) {
    if (e.code === 'ALREADY_NAMED') return res.status(409).json({ error: 'Your name is already set' });
    logError('/api/choose-name error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── API: choose class ────────────────────────────────────────────────────────

app.post('/api/choose-class', validate(schemas.chooseClass), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  if (req.user.characterClass)  return res.status(409).json({ error: 'Class already chosen' });

  const { characterClass } = req.body;

  const cls = CLASSES[characterClass];

  // Build starting stats: schema defaults + class bonuses
  const startingStats = {
    strength:     5   + (cls.baseStats.strength     || 0),
    defense:      5   + (cls.baseStats.defense       || 0),
    speed:        5   + (cls.baseStats.speed         || 0),
    dexterity:    5   + (cls.baseStats.dexterity     || 0),
    intelligence: 5   + (cls.baseStats.intelligence  || 0),
    maxHealth:    100 + (cls.baseStats.maxHealth      || 0),
    health:       100 + (cls.baseStats.health         || 0),
    maxEnergy:    80  + (cls.baseStats.maxEnergy      || 0),
    energy:       80  + (cls.baseStats.energy         || 0),
    gold:         50,
  };

  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.id },
        data:  { characterClass },
      }),
      prisma.stats.upsert({
        where:  { userId: req.user.id },
        update: startingStats,
        create: { userId: req.user.id, ...startingStats },
      }),
    ]);

    // Refresh the session so req.user.characterClass is set before the
    // client redirects to /dashboard (which guards on it).
    const updatedUser = await prisma.user.findUnique({
      where:   { id: req.user.id },
      include: { stats: true },
    });
    req.login(updatedUser, (err) => {
      if (err) return res.status(500).json({ error: 'Session refresh failed' });
      res.json({ ok: true });
    });
  } catch (e) {
    logError(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── API: actions ─────────────────────────────────────────────────────────────

// Helper: apply class energy cost reduction
// Also applies Mana Surge (MAGICIAN_3) — 20% chance to waive cost entirely
async function energyCost(base, characterClass, userId) {
  // Mana Surge passive: 20% free cast
  if (characterClass === 'MAGICIAN' && userId) {
    const surge = await hasSkill(userId, 'MAGICIAN_3');
    if (surge && Math.random() < 0.2) return 0;
  }
  if (characterClass === 'MAGICIAN') return Math.floor(base * 0.75);
  if (characterClass === 'BARD')     return Math.floor(base * 0.90);
  return base;
}

// The old one-click training route (/api/action/train) was removed: it had no
// cooldown and out-gained the Training page (playtest finding E3). All
// training goes through /api/training/train.

app.post('/api/action/rest', blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { characterClass } = req.user;

  // Rest now restores health only — energy regenerates passively over time.
  // Cleric: half price
  let goldCost = 30;
  if (characterClass === 'CLERIC') goldCost = 15;

  try {
    const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });

    // Blessing (CLERIC_3): rest restores an extra 20 HP (still capped at maxHealth)
    let restoredHealth = stats.maxHealth;
    if (characterClass === 'CLERIC' && await hasSkill(req.user.id, 'CLERIC_3')) {
      restoredHealth = Math.min(stats.maxHealth + 20, stats.maxHealth);
    }

    // Atomically enforce gold balance — no cooldown field since lastRestAt was removed.
    const deducted = await prisma.stats.updateMany({
      where: {
        userId: req.user.id,
        gold:   { gte: goldCost },
      },
      data: {
        gold:         { decrement: goldCost },
        health:       restoredHealth,
        energy:       stats.maxEnergy,
        lastEnergyAt: new Date(),
      },
    });

    if (deducted.count === 0) {
      return res.status(400).json({ error: 'Not enough gold to rest' });
    }

    logActivity(req.user.id, 'training', `Rested at the Inn for ${goldCost} gold. Health and energy fully restored.`);
    res.json({ ok: true, discounted: goldCost === 15, goldCost });
  } catch (e) {
    logError('/api/action/rest error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── API: skill tree ──────────────────────────────────────────────────────────

// GET /api/skills — returns the user's class tree + which skills they've unlocked
app.get('/api/skills', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { characterClass } = req.user;
  if (!characterClass) return res.status(400).json({ error: 'No class chosen' });

  const tree = SKILL_TREES[characterClass] || [];

  const userSkills  = await prisma.userSkill.findMany({ where: { userId: req.user.id } });
  const unlockedKeys = userSkills.map(s => s.skillKey);

  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });

  res.json({ tree, unlockedKeys, statPoints: stats?.statPoints ?? 0 });
});

// POST /api/skills/unlock — spend stat points to unlock a skill
app.post('/api/skills/unlock', validate(schemas.skillKey), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });

  const { skillKey } = req.body;
  const skill = getSkillByKey(skillKey);
  if (!skill) return res.status(400).json({ error: 'Unknown skill' });

  // Must belong to the user's class
  const classTree = SKILL_TREES[req.user.characterClass] || [];
  if (!classTree.find(s => s.key === skillKey))
    return res.status(403).json({ error: 'That skill does not belong to your class' });

  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
  if (!stats) return res.status(500).json({ error: 'No stats found' });

  // Already unlocked?
  const already = await prisma.userSkill.findUnique({
    where: { userId_skillKey: { userId: req.user.id, skillKey } },
  });
  if (already) return res.status(409).json({ error: 'Skill already unlocked' });

  // Prerequisite check
  if (skill.requires) {
    const prereq = await prisma.userSkill.findUnique({
      where: { userId_skillKey: { userId: req.user.id, skillKey: skill.requires } },
    });
    if (!prereq) return res.status(400).json({ error: 'Prerequisite skill not unlocked' });
  }

  // Enough stat points?
  if (stats.statPoints < skill.cost)
    return res.status(400).json({ error: 'Not enough stat points' });

  // Build incremental onUnlock deltas (e.g. { maxHealth: { increment: 10 } })
  const onUnlockIncrements = {};
  if (skill.onUnlock) {
    for (const [k, v] of Object.entries(skill.onUnlock)) {
      onUnlockIncrements[k] = { increment: v };
    }
  }

  try {
    // Interactive transaction: deduct points atomically, then create the skill row.
    // If userSkill.create throws P2002 (duplicate), the transaction rolls back so
    // no points are lost even if two requests race through the pre-checks above.
    const updatedStats = await prisma.$transaction(async (tx) => {
      const result = await tx.stats.updateMany({
        where: { userId: req.user.id, statPoints: { gte: skill.cost } },
        data:  { statPoints: { decrement: skill.cost }, ...onUnlockIncrements },
      });
      if (result.count === 0) {
        throw Object.assign(new Error('NOT_ENOUGH_POINTS'), { code: 'NOT_ENOUGH_POINTS' });
      }
      await tx.userSkill.create({ data: { userId: req.user.id, skillKey } });
      return tx.stats.findUnique({ where: { userId: req.user.id } });
    });

    logActivity(req.user.id, 'level', `Unlocked skill: ${skill.name} (-${skill.cost} stat points).`);
    res.json({ ok: true, skill: skill.name, statPointsRemaining: updatedStats.statPoints });
  } catch (e) {
    if (e.code === 'NOT_ENOUGH_POINTS') return res.status(400).json({ error: 'Not enough stat points' });
    if (e.code === 'P2002')             return res.status(409).json({ error: 'Skill already unlocked' });
    logError(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/action/skill — fire an active skill
app.post('/api/action/skill', validate(schemas.skillKey), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });

  const { skillKey } = req.body;
  const skill = getSkillByKey(skillKey);
  if (!skill || skill.type !== 'active')
    return res.status(400).json({ error: 'Invalid active skill' });

  // Must own it
  const owned = await hasSkill(req.user.id, skillKey);
  if (!owned) return res.status(403).json({ error: 'Skill not unlocked' });

  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });

  // Helper: atomically deduct energy, returns false if insufficient.
  async function deductEnergy(cost) {
    await regenEnergy(req.user.id);
    const r = await prisma.stats.updateMany({
      where: { userId: req.user.id, energy: { gte: cost } },
      data:  { energy: { decrement: cost } },
    });
    return r.count > 0;
  }

  switch (skillKey) {
    case 'WARRIOR_2': { // Shield Bash — 15 energy, 15 dmg placeholder
      if (!await deductEnergy(15)) return res.status(400).json({ error: 'Not enough energy' });
      return res.json({ ok: true, message: 'Shield Bash connects — 15 damage dealt!', energyCost: 15 });
    }

    case 'RANGER_2': { // Ambush — 18 energy, 25 dmg
      if (!await deductEnergy(18)) return res.status(400).json({ error: 'Not enough energy' });
      return res.json({ ok: true, message: 'You strike from the shadows — 25 damage!', energyCost: 18 });
    }

    case 'MAGICIAN_2': { // Fireball — 12 energy, 35 dmg
      if (!await deductEnergy(12)) return res.status(400).json({ error: 'Not enough energy' });
      return res.json({ ok: true, message: 'Fireball erupts — 35 damage!', energyCost: 12 });
    }

    case 'NECROMANCER_2': { // Soul Drain — 20 energy, heal 25 HP
      if (!await deductEnergy(20)) return res.status(400).json({ error: 'Not enough energy' });
      // Read fresh health after energy is safely deducted, then cap heal at maxHealth.
      const fresh      = await prisma.stats.findUnique({ where: { userId: req.user.id } });
      const newHp      = Math.min(fresh.health + 25, fresh.maxHealth);
      const healAmount = newHp - fresh.health;
      await prisma.stats.update({ where: { userId: req.user.id }, data: { health: newHp } });
      return res.json({ ok: true, message: `Soul Drain — you absorb ${healAmount} HP.`, energyCost: 20, healAmount });
    }

    case 'SHADOWBLADE_2': { // Backstab — 15 energy, bonus gold
      if (!await deductEnergy(15)) return res.status(400).json({ error: 'Not enough energy' });
      const bonusGold = Math.floor(Math.random() * 30) + 20;
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { gold: { increment: bonusGold } },
      });
      return res.json({ ok: true, message: `Backstab lands true — ${bonusGold} gold looted!`, energyCost: 15, goldGain: bonusGold });
    }

    case 'CLERIC_2': { // Holy Light — 20 energy, heal 40 HP
      if (!await deductEnergy(20)) return res.status(400).json({ error: 'Not enough energy' });
      const fresh      = await prisma.stats.findUnique({ where: { userId: req.user.id } });
      const newHp      = Math.min(fresh.health + 40, fresh.maxHealth);
      const healAmount = newHp - fresh.health;
      await prisma.stats.update({ where: { userId: req.user.id }, data: { health: newHp } });
      return res.json({ ok: true, message: `Holy Light heals you for ${healAmount} HP.`, energyCost: 20, healAmount });
    }

    case 'BARD_2': { // Ballad of Greed — 10 energy, 25–50 gold
      if (!await deductEnergy(10)) return res.status(400).json({ error: 'Not enough energy' });
      const charmGold = Math.floor(Math.random() * 26) + 25;
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { gold: { increment: charmGold } },
      });
      return res.json({ ok: true, message: `The crowd weeps and pays — ${charmGold} gold collected!`, energyCost: 10, goldGain: charmGold });
    }

    default:
      return res.status(400).json({ error: 'No action defined for this skill' });
  }
});

// ─── API: level-up helper ─────────────────────────────────────────────────────

// Fire-and-forget activity log write. Never blocks or breaks gameplay if it
// fails — logging is a nice-to-have, not a critical path.
function logActivity(userId, category, message) {
  prisma.activityLog.create({ data: { userId, category, message } })
    .catch(err => logError('logActivity error:', err));
}

async function checkLevelUp(userId) {
  const user  = await prisma.user.findUnique({ where: { id: userId } });
  const stats = await prisma.stats.findUnique({ where: { userId } });
  const xpNeeded = stats.level * 100;

  if (stats.xp < xpNeeded) return { leveledUp: false };

  const cls      = user.characterClass ? CLASSES[user.characterClass] : {};
  const perLevel = cls.perLevel || {};
  const newLevel     = stats.level + 1;
  const newXp        = stats.xp - xpNeeded;
  const newMaxHealth = stats.maxHealth + 20 + (perLevel.maxHealth || 0);
  const newMaxEnergy = stats.maxEnergy + 10;

  // Guard with the current level in the WHERE clause so that if two concurrent
  // requests both see enough XP, only one UPDATE wins (the other matches 0 rows).
  const result = await prisma.stats.updateMany({
    where: { userId, level: stats.level, xp: { gte: xpNeeded } },
    data: {
      level:        newLevel,
      xp:           newXp,
      maxHealth:    newMaxHealth,
      health:       newMaxHealth,
      maxEnergy:    newMaxEnergy,
      energy:       newMaxEnergy,
      statPoints:   { increment: 3 },
      strength:     { increment: perLevel.strength     || 0 },
      defense:      { increment: perLevel.defense      || 0 },
      speed:        { increment: perLevel.speed        || 0 },
      dexterity:    { increment: perLevel.dexterity    || 0 },
      intelligence: { increment: perLevel.intelligence || 0 },
    },
  });

  if (result.count === 0) return { leveledUp: false }; // another concurrent request won the race
  logActivity(userId, 'level', `Reached Level ${newLevel}! +3 stat points awarded.`);
  return { leveledUp: true, newLevel, statPoints: stats.statPoints + 3 };
}

// ─── API: spend stat points ───────────────────────────────────────────────────

app.post('/api/spend-stat', validate(schemas.spendStat), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { stat } = req.body;

  // Atomic: deduct a stat point and increment the chosen stat in one shot.
  // The WHERE guard (statPoints >= 1) means count === 0 → genuinely out of points.
  const result = await prisma.stats.updateMany({
    where: { userId: req.user.id, statPoints: { gte: 1 } },
    data:  { [stat]: { increment: 1 }, statPoints: { decrement: 1 } },
  });
  if (result.count === 0) return res.status(400).json({ error: 'No stat points available' });

  const updated = await prisma.stats.findUnique({ where: { userId: req.user.id } });
  res.json({ ok: true, stat, newValue: updated[stat] });
});

// ─── Start ────────────────────────────────────────────────────────────────────
// ─── REALM MAP ────────────────────────────────────────────────────────────────
app.get('/api/players', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const players = await prisma.user.findMany({
    where: { characterName: { not: null } },
    select: {
      id: true,
      characterName: true,
      createdAt: true,
      stats: { select: { level: true, strength: true, defense: true, gold: true } },
      houseMember: { select: { rank: true, house: { select: { name: true } } } }
    },
    orderBy: { stats: { level: 'desc' } }
  });
  res.json(players);
});

// ─── HOUSE ────────────────────────────────────────────────────────────────────
// Joining a house is a request the Lord approves or denies. Anyone can leave;
// a leaving Lord hands the house on (see /api/house/leave). A Lord can also
// disband the house; any gold in the house vault goes back to the Lord. Housemates can't raid each other (see
// /api/raid/player).

async function houseOf(userId) {
  return prisma.houseMember.findUnique({ where: { userId }, include: { house: true } });
}

app.get('/api/house', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const member = await prisma.houseMember.findUnique({
    where: { userId: req.user.id },
    include: {
      house: {
        include: {
          members: {
            include: { user: { select: { characterName: true, stats: { select: { level: true, strength: true } } } } }
          }
        }
      }
    }
  });
  // The Lord also sees who is asking to join.
  if (member && member.house.leaderId === req.user.id) {
    member.joinRequests = await prisma.houseJoinRequest.findMany({
      where: { houseId: member.houseId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, user: { select: { characterName: true, characterClass: true, stats: { select: { level: true } } } } },
    });
  }
  res.json(member || null);
});

app.get('/api/houses', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const houses = await prisma.house.findMany({
    include: { _count: { select: { members: true } } },
    orderBy: { gold: 'desc' }
  });
  res.json(houses);
});

// The player's own open join request, if any.
app.get('/api/house/request', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const request = await prisma.houseJoinRequest.findUnique({
    where: { userId: req.user.id },
    select: { id: true, houseId: true, createdAt: true, house: { select: { name: true } } },
  });
  res.json({ request });
});

app.post('/api/house/create', validate(schemas.houseCreate), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { name, motto } = req.body;
  const existing = await prisma.houseMember.findUnique({ where: { userId: req.user.id } });
  if (existing) return res.status(400).json({ error: 'You already belong to a house' });
  const clash = await prisma.house.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
  if (clash) return res.status(409).json({ error: 'That house name is already taken' });
  try {
    const house = await prisma.$transaction(async (tx) => {
      // Atomically deduct 500 gold — rolls back house creation if insufficient.
      const deducted = await tx.stats.updateMany({
        where: { userId: req.user.id, gold: { gte: 500 } },
        data:  { gold: { decrement: 500 } },
      });
      if (deducted.count === 0) throw Object.assign(new Error('Not enough gold'), { code: 'NO_GOLD' });

      // Founding a house withdraws any request to join another one.
      await tx.houseJoinRequest.deleteMany({ where: { userId: req.user.id } });

      return tx.house.create({
        data: {
          name,
          motto:   motto || 'Strength through unity.',
          leaderId: req.user.id,
          members: { create: { userId: req.user.id, rank: 'Lord' } },
        },
      });
    });
    res.json({ ok: true, house });
  } catch (e) {
    if (e.code === 'NO_GOLD') return res.status(400).json({ error: 'Founding a house costs 500 gold' });
    if (e.code === 'P2002')   return res.status(409).json({ error: 'That house name is already taken' });
    logError(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Ask to join a house. Asking a different house replaces the earlier request.
app.post('/api/house/join', validate(schemas.houseJoin), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { houseId } = req.body;
  const existing = await prisma.houseMember.findUnique({ where: { userId: req.user.id } });
  if (existing) return res.status(400).json({ error: 'You already belong to a house' });
  const house = await prisma.house.findUnique({ where: { id: houseId } });
  if (!house) return res.status(404).json({ error: 'House not found' });
  await prisma.houseJoinRequest.upsert({
    where:  { userId: req.user.id },
    update: { houseId, createdAt: new Date() },
    create: { userId: req.user.id, houseId },
  });
  logActivity(req.user.id, 'house', `Asked to join House ${house.name}.`);
  res.json({ ok: true, requested: true, houseName: house.name });
});

app.post('/api/house/request/cancel', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { count } = await prisma.houseJoinRequest.deleteMany({ where: { userId: req.user.id } });
  if (count === 0) return res.status(404).json({ error: 'You have no open request' });
  res.json({ ok: true });
});

// Lord only: approve or deny a request to join their house.
app.post('/api/house/requests/:requestId/:decision', blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { decision } = req.params;
  const requestId = parseInt(req.params.requestId, 10);
  if (!['approve', 'deny'].includes(decision) || !Number.isInteger(requestId)) return res.status(404).json({ error: 'Not found' });

  const mine = await houseOf(req.user.id);
  if (!mine || mine.house.leaderId !== req.user.id) return res.status(403).json({ error: 'Only the Lord of a house can answer requests' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.houseJoinRequest.findUnique({
        where: { id: requestId },
        include: { user: { select: { characterName: true } } },
      });
      if (!request || request.houseId !== mine.houseId) throw { code: 'NO_REQUEST' };
      await tx.houseJoinRequest.delete({ where: { id: requestId } });
      if (decision === 'deny') return { name: request.user.characterName, userId: request.userId };
      // userId is unique on HouseMember, so a player can never end up in two houses.
      await tx.houseMember.create({ data: { userId: request.userId, houseId: mine.houseId, rank: 'Bannerman' } });
      return { name: request.user.characterName, userId: request.userId };
    });
    logActivity(result.userId, 'house', decision === 'approve'
      ? `Your request to join House ${mine.house.name} was accepted.`
      : `Your request to join House ${mine.house.name} was declined.`);
    res.json({ ok: true, decision, name: result.name });
  } catch (e) {
    if (e && e.code === 'NO_REQUEST') return res.status(404).json({ error: 'That request is no longer open' });
    if (e && e.code === 'P2002')      return res.status(409).json({ error: 'That player already belongs to a house' });
    logError('/api/house/requests error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Anyone can leave their house, even from a cell or the Infirmary.
// A Lord who leaves hands the house to the highest-level member (ties go to
// whoever joined first). A Lord with no one left closes the house and takes
// the vault gold, the same as disbanding.
app.post('/api/house/leave', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const member = await tx.houseMember.findUnique({ where: { userId: req.user.id }, include: { house: true } });
      if (!member) return { error: 'You are not in a house' };
      const house = member.house;
      const gone = await tx.houseMember.deleteMany({ where: { userId: req.user.id, houseId: house.id } });
      if (gone.count === 0) return { error: 'You are not in a house' }; // a second click got here first

      if (house.leaderId !== req.user.id) {
        return { house, wasLord: false };
      }
      const rest = await tx.houseMember.findMany({
        where: { houseId: house.id },
        include: { user: { select: { characterName: true, stats: { select: { level: true } } } } },
      });
      if (rest.length === 0) {
        await tx.house.delete({ where: { id: house.id } }); // join requests cascade
        if (house.gold > 0) await tx.stats.update({ where: { userId: req.user.id }, data: { gold: { increment: house.gold } } });
        return { house, wasLord: true, closed: true, goldReturned: house.gold };
      }
      rest.sort((a, b) => (b.user.stats?.level ?? 0) - (a.user.stats?.level ?? 0) || a.id - b.id);
      const heir = rest[0];
      await tx.house.update({ where: { id: house.id }, data: { leaderId: heir.userId } });
      await tx.houseMember.update({ where: { id: heir.id }, data: { rank: 'Lord' } });
      return { house, wasLord: true, heir: { userId: heir.userId, name: heir.user.characterName }, others: rest.slice(1).map(m => m.userId) };
    });
    if (result.error) return res.status(400).json({ error: result.error });

    const { house } = result;
    const me = req.user.characterName || 'A bannerman';
    if (!result.wasLord) {
      logActivity(req.user.id, 'house', `You left House ${house.name}.`);
      logActivity(house.leaderId, 'house', `${me} has left House ${house.name}.`);
      return res.json({ ok: true });
    }
    if (result.closed) {
      logActivity(req.user.id, 'house', `You left House ${house.name}. With no one left, the house is closed.${result.goldReturned > 0 ? ` ${result.goldReturned} gold returned from the vault.` : ''}`);
      return res.json({ ok: true, closed: true, goldReturned: result.goldReturned });
    }
    logActivity(req.user.id, 'house', `You left House ${house.name}. ${result.heir.name} is now its Lord.`);
    logActivity(result.heir.userId, 'house', `${me} has left House ${house.name}. You are now its Lord.`);
    for (const id of result.others) logActivity(id, 'house', `${me} has left House ${house.name}. ${result.heir.name} is now its Lord.`);
    res.json({ ok: true, newLord: result.heir.name });
  } catch (e) {
    logError('house leave error:', e);
    res.status(500).json({ error: 'Could not leave the house. Try again.' });
  }
});

// Lord only: disband the house. Members are released, open requests are
// dropped, and any vault gold goes back to the Lord.
app.post('/api/house/disband', blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const mine = await houseOf(req.user.id);
  if (!mine) return res.status(400).json({ error: 'You are not in a house' });
  if (mine.house.leaderId !== req.user.id) return res.status(403).json({ error: 'Only the Lord can disband the house' });
  const house = mine.house;
  const members = await prisma.houseMember.findMany({ where: { houseId: house.id }, select: { userId: true } });
  await prisma.$transaction([
    prisma.houseMember.deleteMany({ where: { houseId: house.id } }),
    prisma.house.delete({ where: { id: house.id } }),   // join requests cascade
    ...(house.gold > 0 ? [prisma.stats.update({ where: { userId: req.user.id }, data: { gold: { increment: house.gold } } })] : []),
  ]);
  for (const m of members) {
    logActivity(m.userId, 'house', m.userId === req.user.id
      ? `You disbanded House ${house.name}.${house.gold > 0 ? ` ${house.gold} gold returned from the vault.` : ''}`
      : `House ${house.name} was disbanded by its Lord.`);
  }
  res.json({ ok: true, goldReturned: house.gold });
});

// ─── MARKET ───────────────────────────────────────────────────────────────────
// Takes down every listing past its expiry and returns the items to their
// sellers. Safe to call from several requests at once: each listing is only
// returned by whichever call manages to delete it.
// Removes a listing and puts its items back in the seller's inventory.
// Returns false if the listing was already gone (bought, cancelled or expired
// by a request that got there first), so nothing is ever returned twice.
async function takeDownListing(tx, l) {
  const gone = await tx.listing.deleteMany({ where: { id: l.id, sellerId: l.sellerId } });
  if (gone.count === 0) return false;
  const existing = await tx.inventory.findFirst({ where: { userId: l.sellerId, itemId: l.itemId } });
  if (existing) {
    await tx.inventory.update({ where: { id: existing.id }, data: { quantity: { increment: l.quantity } } });
  } else {
    await tx.inventory.create({ data: { userId: l.sellerId, itemId: l.itemId, quantity: l.quantity } });
  }
  return true;
}

async function expireListings() {
  const due = await prisma.listing.findMany({
    where: { expiresAt: { lte: new Date() } },
    include: { item: { select: { name: true } } },
    take: 200,
  });
  for (const l of due) {
    try {
      const returned = await prisma.$transaction(tx => takeDownListing(tx, l));
      if (returned) {
        logActivity(l.sellerId, 'inventory', `Your market listing for ${l.quantity}x ${l.item.name} expired unsold. The items are back in your inventory.`);
      }
    } catch (e) {
      logError('expireListings error for listing', l.id, e);
    }
  }
}
setInterval(() => expireListings().catch(e => logError('expireListings sweep error:', e)), 15 * 60 * 1000).unref();

app.get('/api/market/listings', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  await expireListings();
  const listings = await prisma.listing.findMany({
    include: {
      item: true,
      seller: { select: { characterName: true } }
    },
    orderBy: { createdAt: 'desc' }
  });
  res.json(listings);
});

// Market rules, for the page to show the fee and timer.
app.get('/api/market/rules', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  res.json({ feeRate: MARKET_LISTING_FEE_RATE, listingDays: MARKET_LISTING_DAYS, maxPrice: MARKET_MAX_PRICE });
});

app.get('/api/market/inventory', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  await expireListings();
  const inventory = await prisma.inventory.findMany({
    where: { userId: req.user.id },
    include: { item: true }
  });
  res.json(inventory);
});

app.post('/api/market/buy', validate(schemas.marketBuy), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { listingId } = req.body;
  await expireListings(); // an expired listing goes back to its seller, not to a buyer

  try {
    const listing = await prisma.$transaction(async (tx) => {
      // Fetch and immediately delete the listing inside the transaction.
      // This is the serialization lock: the second concurrent buyer's DELETE
      // will throw P2025 (record not found), rolling back their transaction
      // before any gold or inventory changes are made.
      const found = await tx.listing.findUnique({ where: { id: listingId }, include: { item: true } });
      if (!found || found.expiresAt <= new Date()) throw Object.assign(new Error('Listing not found'), { code: 'NOT_FOUND' });
      if (found.sellerId === req.user.id) throw Object.assign(new Error('Cannot buy own listing'), { code: 'OWN_LISTING' });

      await tx.listing.delete({ where: { id: listingId } });

      // Atomically deduct buyer gold — rolls back everything if insufficient.
      const deducted = await tx.stats.updateMany({
        where: { userId: req.user.id, gold: { gte: found.price } },
        data:  { gold: { decrement: found.price } },
      });
      if (deducted.count === 0) throw Object.assign(new Error('Not enough gold'), { code: 'NO_GOLD' });

      // Credit the seller.
      await tx.stats.update({
        where: { userId: found.sellerId },
        data:  { gold: { increment: found.price } },
      });

      // Add item to buyer inventory (upsert-style).
      const existing = await tx.inventory.findFirst({ where: { userId: req.user.id, itemId: found.itemId } });
      if (existing) {
        await tx.inventory.update({ where: { id: existing.id }, data: { quantity: { increment: found.quantity } } });
      } else {
        await tx.inventory.create({ data: { userId: req.user.id, itemId: found.itemId, quantity: found.quantity } });
      }

      return found;
    });

    res.json({ ok: true, item: listing.item.name });
  } catch (e) {
    if (e.code === 'NOT_FOUND')   return res.status(404).json({ error: 'Listing no longer available' });
    if (e.code === 'OWN_LISTING') return res.status(400).json({ error: 'You cannot buy your own listing' });
    if (e.code === 'NO_GOLD')     return res.status(400).json({ error: 'Not enough gold' });
    if (e.code === 'P2025')       return res.status(404).json({ error: 'Listing no longer available' });
    logError(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Sellers can take down their own listing at any time. The items come back;
// the listing fee does not (otherwise listing would be a free way to park items).
app.post('/api/market/cancel', validate(schemas.marketBuy), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { listingId } = req.body;
  try {
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { item: { select: { name: true } } } });
    if (!listing) return res.status(404).json({ error: 'Listing no longer available' });
    if (listing.sellerId !== req.user.id) return res.status(403).json({ error: 'You can only cancel your own listings' });
    const returned = await prisma.$transaction(tx => takeDownListing(tx, listing));
    if (!returned) return res.status(404).json({ error: 'Listing no longer available' });
    logActivity(req.user.id, 'inventory', `You took down your market listing for ${listing.quantity}x ${listing.item.name}. The items are back in your inventory.`);
    res.json({ ok: true, itemName: listing.item.name, quantity: listing.quantity });
  } catch (e) {
    logError('/api/market/cancel error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/market/list', validate(schemas.marketList), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { inventoryId, price, quantity } = req.body;
  const fee = listingFee(price);
  try {
    // One transaction: take the items out of the satchel (only if they're
    // still there), charge the fee (only if the gold is there), then post the
    // listing. Any failure rolls all of it back, and two simultaneous listings
    // of the same item can't both succeed.
    const listing = await prisma.$transaction(async (tx) => {
      const taken = await tx.inventory.updateMany({
        where: { id: inventoryId, userId: req.user.id, quantity: { gte: quantity } },
        data:  { quantity: { decrement: quantity } },
      });
      if (taken.count === 0) {
        const inv = await tx.inventory.findFirst({ where: { id: inventoryId, userId: req.user.id } });
        throw { code: inv ? 'NOT_ENOUGH' : 'NOT_FOUND' };
      }
      const paid = await tx.stats.updateMany({
        where: { userId: req.user.id, gold: { gte: fee } },
        data:  { gold: { decrement: fee } },
      });
      if (paid.count === 0) throw { code: 'NO_GOLD' };

      const inv = await tx.inventory.findUnique({ where: { id: inventoryId }, include: { item: { select: { name: true } } } });
      if (inv.quantity <= 0) await tx.inventory.delete({ where: { id: inventoryId } });

      const created = await tx.listing.create({
        data: { sellerId: req.user.id, itemId: inv.itemId, price, quantity, expiresAt: new Date(Date.now() + MARKET_LISTING_MS) },
      });
      return { ...created, itemName: inv.item.name };
    });
    logActivity(req.user.id, 'inventory', `Listed ${quantity}x ${listing.itemName} on the market for ${price} gold (fee ${fee} gold).`);
    res.json({ ok: true, fee, expiresAt: listing.expiresAt, listingId: listing.id });
  } catch (e) {
    if (e && e.code === 'NOT_FOUND')  return res.status(404).json({ error: 'Item not found in your inventory' });
    if (e && e.code === 'NOT_ENOUGH') return res.status(400).json({ error: 'Not enough of that item' });
    if (e && e.code === 'NO_GOLD')    return res.status(400).json({ error: `Listing this costs a ${fee} gold fee (10% of the price). You don't have enough gold.` });
    logError('/api/market/list error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── INVENTORY & GENERAL STORE ──────────────────────────────────────────────────

// Parses an effect string like "health:30,energy:20" into { health: 30, energy: 20 }.
function parseItemEffect(effectStr) {
  const result = {};
  if (!effectStr) return result;
  effectStr.split(',').forEach(pair => {
    const [k, v] = pair.split(':').map(s => s && s.trim());
    const n = parseInt(v, 10);
    if (k && !Number.isNaN(n)) result[k] = n;
  });
  return result;
}

app.get('/api/inventory', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  await expireListings(); // expired listings come back to the satchel
  const inventory = await prisma.inventory.findMany({
    where: { userId: req.user.id },
    include: { item: true },
    orderBy: { id: 'asc' },
  });
  res.json({ inventory });
});

app.post('/api/inventory/use', validate(schemas.inventoryId), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { inventoryId } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Row-lock the player's Stats so a used item's effect can't race with
      // any other concurrent action that reads/writes health, energy, etc.
      const statsRows = await tx.$queryRaw`
        SELECT * FROM "Stats" WHERE "userId" = ${req.user.id} FOR UPDATE
      `;
      const stats = statsRows[0];
      if (!stats) throw { code: 'NO_STATS' };

      const inv = await tx.inventory.findFirst({
        where: { id: inventoryId, userId: req.user.id },
        include: { item: true },
      });
      if (!inv) throw { code: 'NOT_FOUND' };
      if (inv.item.type !== 'consumable') throw { code: 'NOT_USABLE' };

      const effect = parseItemEffect(inv.item.effect);
      const statsUpdate = {};
      const applied = [];

      if (effect.health) {
        const newHealth = Math.min(stats.maxHealth, stats.health + effect.health);
        statsUpdate.health = newHealth;
        applied.push({ stat: 'health', amount: newHealth - stats.health });
      }
      if (effect.energy) {
        const newEnergy = Math.min(stats.maxEnergy, stats.energy + effect.energy);
        statsUpdate.energy = newEnergy;
        applied.push({ stat: 'energy', amount: newEnergy - stats.energy });
      }
      if (effect.xp) {
        statsUpdate.xp = { increment: effect.xp };
        applied.push({ stat: 'xp', amount: effect.xp });
      }
      if (effect.gold) {
        statsUpdate.gold = { increment: effect.gold };
        applied.push({ stat: 'gold', amount: effect.gold });
      }

      if (Object.keys(statsUpdate).length > 0) {
        await tx.stats.update({ where: { userId: req.user.id }, data: statsUpdate });
      }

      if (inv.quantity - 1 <= 0) {
        await tx.inventory.delete({ where: { id: inv.id } });
      } else {
        await tx.inventory.update({ where: { id: inv.id }, data: { quantity: { decrement: 1 } } });
      }

      return { itemName: inv.item.name, applied };
    });

    const levelUp = await checkLevelUp(req.user.id);
    const appliedText = result.applied.map(a => `+${a.amount} ${a.stat}`).join(', ');
    logActivity(req.user.id, 'inventory', `Used ${result.itemName}. ${appliedText}`);
    res.json({ ...result, ...levelUp });

  } catch (e) {
    if (e && e.code === 'NOT_FOUND')  return res.status(404).json({ error: 'Item not found in your inventory' });
    if (e && e.code === 'NOT_USABLE') return res.status(400).json({ error: 'That item cannot be used' });
    logError('/api/inventory/use error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// The General Store sells potions and building materials only. Monster drops
// (Ancient Coin, Golem Core, trophies…) have to be earned. The list and the
// buy button use this same rule (playtest finding E4).
const STORE_ITEM_TYPES = ['consumable', 'crafting'];

app.get('/api/shop/items', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const items = await prisma.item.findMany({
    where: { type: { in: STORE_ITEM_TYPES } },
    orderBy: [{ type: 'asc' }, { basePrice: 'asc' }],
  });
  res.json({ items });
});

app.post('/api/shop/buy', validate(schemas.shopBuy), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { itemId, quantity } = req.body;
  const qty = quantity;

  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!STORE_ITEM_TYPES.includes(item.type)) {
    return res.status(400).json({ error: `The General Store doesn't sell ${item.name}.`, notForSale: true });
  }

  const cost = item.basePrice * qty;

  try {
    await prisma.$transaction(async (tx) => {
      const deducted = await tx.stats.updateMany({
        where: { userId: req.user.id, gold: { gte: cost } },
        data:  { gold: { decrement: cost } },
      });
      if (deducted.count === 0) throw { code: 'NO_GOLD' };

      const existing = await tx.inventory.findFirst({ where: { userId: req.user.id, itemId: item.id } });
      if (existing) {
        await tx.inventory.update({ where: { id: existing.id }, data: { quantity: { increment: qty } } });
      } else {
        await tx.inventory.create({ data: { userId: req.user.id, itemId: item.id, quantity: qty } });
      }
    });

    logActivity(req.user.id, 'inventory', `Bought ${qty}x ${item.name} for ${cost} gold.`);
    res.json({ ok: true, itemName: item.name, quantity: qty, cost });
  } catch (e) {
    if (e && e.code === 'NO_GOLD') return res.status(400).json({ error: 'Not enough gold' });
    logError('/api/shop/buy error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/inventory/sell', validate(schemas.inventorySell), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { inventoryId, quantity } = req.body;
  const qty = quantity;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const inv = await tx.inventory.findFirst({
        where: { id: inventoryId, userId: req.user.id },
        include: { item: true },
      });
      if (!inv) throw { code: 'NOT_FOUND' };
      if (inv.quantity < qty) throw { code: 'NOT_ENOUGH' };

      // Vendors pay half base price — keeps buying then reselling a
      // consumable from a net gain, and gives junk drops real value.
      const unitValue = Math.max(1, Math.floor(inv.item.basePrice * 0.5));
      const totalValue = unitValue * qty;

      if (inv.quantity - qty <= 0) {
        await tx.inventory.delete({ where: { id: inv.id } });
      } else {
        await tx.inventory.update({ where: { id: inv.id }, data: { quantity: { decrement: qty } } });
      }

      await tx.stats.update({ where: { userId: req.user.id }, data: { gold: { increment: totalValue } } });

      return { itemName: inv.item.name, qty, totalValue };
    });

    logActivity(req.user.id, 'inventory', `Sold ${result.qty}x ${result.itemName} for ${result.totalValue} gold.`);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e && e.code === 'NOT_FOUND')   return res.status(404).json({ error: 'Item not found in your inventory' });
    if (e && e.code === 'NOT_ENOUGH')  return res.status(400).json({ error: 'Not enough of that item' });
    logError('/api/inventory/sell error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const TRAINING_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const TRAINING_CONFIG = {
  strength: { energyCost: 15, xpGain: 8,  statField: 'strength', cooldownField: 'lastStrengthTrain' },
  defense:  { energyCost: 15, xpGain: 8,  statField: 'defense',  cooldownField: 'lastDefenseTrain'  },
  speed:    { energyCost: 15, xpGain: 8,  statField: 'speed',    cooldownField: 'lastSpeedTrain'    },
  dexterity:{ energyCost: 15, xpGain: 8,  statField: 'dexterity',cooldownField: 'lastDexTrain'      },
};

app.get('/api/training/status', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  await regenEnergy(req.user.id);
  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
  const now = Date.now();
  const cooldowns = {};
  for (const [stat, cfg] of Object.entries(TRAINING_CONFIG)) {
    const last = stats[cfg.cooldownField];
    const elapsed = last ? now - new Date(last).getTime() : TRAINING_COOLDOWN_MS + 1;
    const remaining = Math.max(0, TRAINING_COOLDOWN_MS - elapsed);
    cooldowns[stat] = { ready: remaining === 0, remainingMs: remaining };
  }
  res.json({ stats, cooldowns });
});

app.post('/api/training/train', validate(schemas.trainingTrain), blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { stat } = req.body;
  const cfg = TRAINING_CONFIG[stat];
  if (!cfg) return res.status(400).json({ error: 'Invalid stat' });

  await regenEnergy(req.user.id);
  const now    = new Date();
  const cutoff = new Date(now.getTime() - TRAINING_COOLDOWN_MS);

  // Atomically enforce both the energy requirement AND the cooldown in a single
  // WHERE clause — two concurrent requests can't both slip through.
  const deducted = await prisma.stats.updateMany({
    where: {
      userId: req.user.id,
      energy: { gte: cfg.energyCost },
      OR: [
        { [cfg.cooldownField]: null },
        { [cfg.cooldownField]: { lte: cutoff } },
      ],
    },
    data: {
      energy:             { decrement: cfg.energyCost },
      xp:                 { increment: cfg.xpGain },
      [cfg.cooldownField]: now,
    },
  });

  if (deducted.count === 0) {
    // Re-read once to return a specific error message.
    const s = await prisma.stats.findUnique({ where: { userId: req.user.id } });
    if (s.energy < cfg.energyCost) return res.status(400).json({ error: 'Not enough energy' });
    const last      = s[cfg.cooldownField];
    const elapsed   = last ? now - new Date(last).getTime() : TRAINING_COOLDOWN_MS + 1;
    const remaining = Math.ceil((TRAINING_COOLDOWN_MS - elapsed) / 1000);
    return res.status(400).json({ error: `Still recovering — ${remaining}s remaining` });
  }

  // Stat gain is random and incremental — safe to apply in a second write.
  const gain    = Math.floor(Math.random() * 2) + 1;
  const updated = await prisma.stats.update({
    where: { userId: req.user.id },
    data:  { [cfg.statField]: { increment: gain } },
  });

  const levelUp = await checkLevelUp(req.user.id);
  logActivity(req.user.id, 'training', `Trained ${cfg.statField}: +${gain}, +${cfg.xpGain} XP.`);
  res.json({ gain, xpGain: cfg.xpGain, newValue: updated[cfg.statField], stat, ...levelUp });
});

// ─── RAIDS ────────────────────────────────────────────────────────────────────

const NPC_LOCATIONS = [
  {
    id: 'village',
    name: 'Village Market',
    desc: 'A small trading post with little protection. Easy pickings for a desperate lord.',
    risk: 'LOW',
    energyCost: 10,
    goldMin: 30, goldMax: 80,
    xpGain: 10,
    difficulty: 8,
    jailChance: 0.2,
    jailMins: 5,
  },
  {
    id: 'caravan',
    name: 'Merchant Caravan',
    desc: 'A guarded convoy moving between towns. Hired swords protect the cargo.',
    risk: 'MEDIUM',
    energyCost: 20,
    goldMin: 100, goldMax: 250,
    xpGain: 25,
    difficulty: 18,
    jailChance: 0.35,
    jailMins: 10,
  },
  {
    id: 'manor',
    name: "Noble's Manor",
    desc: 'A wealthy lord sleeps behind thick walls and loyal guards. The reward justifies the risk.',
    risk: 'HIGH',
    energyCost: 30,
    goldMin: 300, goldMax: 600,
    xpGain: 50,
    difficulty: 30,
    jailChance: 0.5,
    jailMins: 20,
  },
  {
    id: 'treasury',
    name: 'Royal Treasury',
    desc: 'The crown jewels and tax reserves of the realm. Only a fool or a legend attempts this.',
    risk: 'EXTREME',
    energyCost: 50,
    goldMin: 800, goldMax: 2000,
    xpGain: 120,
    difficulty: 55,
    jailChance: 0.7,
    jailMins: 45,
  },
];

// Helper: check and clear jail/hospital status
// Passive energy regen — call before any action that reads or spends energy.
// Calculates how many full 5-minute intervals have passed since lastEnergyAt,
// adds 5 energy per interval (capped at maxEnergy), and advances lastEnergyAt
// by the exact time consumed so partial intervals carry over correctly.
async function regenEnergy(userId) {
  const stats = await prisma.stats.findUnique({
    where:  { userId },
    select: { energy: true, maxEnergy: true, lastEnergyAt: true },
  });
  if (!stats) return;

  const now = new Date();

  // While full (or never started), keep the clock pinned to "now" so the first
  // regen tick lands a full interval after energy is spent — no free instant tick.
  if (stats.energy >= stats.maxEnergy || !stats.lastEnergyAt) {
    await prisma.stats.update({ where: { userId }, data: { lastEnergyAt: now } });
    return;
  }

  const lastAt    = stats.lastEnergyAt;
  const elapsed   = now - lastAt;
  const intervals = Math.floor(elapsed / ENERGY_REGEN_INTERVAL_MS);

  if (intervals === 0) return; // not enough time has passed yet

  const gained    = intervals * ENERGY_REGEN_AMOUNT;
  const newEnergy = Math.min(stats.energy + gained, stats.maxEnergy);
  // Advance lastEnergyAt by exactly the intervals consumed — preserves leftover time.
  // If this tick filled the bar, restart the clock from now instead.
  const newLastAt = newEnergy >= stats.maxEnergy
    ? now
    : new Date(lastAt.getTime() + intervals * ENERGY_REGEN_INTERVAL_MS);

  await prisma.stats.update({
    where: { userId },
    data:  { energy: newEnergy, lastEnergyAt: newLastAt },
  });
}

// Countdown info for the UI: ms until the next +N tick and until the bar is full.
function energyTimers(stats, now = Date.now()) {
  if (!stats || stats.energy >= stats.maxEnergy) {
    return { nextTickMs: null, fullMs: null };
  }
  const lastAt     = stats.lastEnergyAt ? new Date(stats.lastEnergyAt).getTime() : now;
  const nextTickMs = Math.max(0, lastAt + ENERGY_REGEN_INTERVAL_MS - now);
  const ticksLeft  = Math.ceil((stats.maxEnergy - stats.energy) / ENERGY_REGEN_AMOUNT);
  const fullMs     = nextTickMs + (ticksLeft - 1) * ENERGY_REGEN_INTERVAL_MS;
  return { nextTickMs, fullMs };
}

async function checkStatus(userId) {
  // Finish any journey whose arrival time has passed, then apply pending energy regen.
  await settleTravel(userId);
  await regenEnergy(userId);

  const stats = await prisma.stats.findUnique({ where: { userId } });
  const now = new Date();
  const updates = {};
  if (stats.inJail && stats.jailUntil && now >= stats.jailUntil) {
    updates.inJail = false;
    updates.jailUntil = null;
  }
  if (stats.inHospital && stats.hospitalUntil && now >= stats.hospitalUntil) {
    updates.inHospital = false;
    updates.hospitalUntil = null;
    updates.health = stats.maxHealth;
  }
  if (Object.keys(updates).length > 0) {
    return await prisma.stats.update({ where: { userId }, data: updates });
  }
  return stats;
}

// ─── Jail / hospital lockout ──────────────────────────────────────────────────
// A jailed or hospitalized player can still look around (every GET), manage
// their character (stat points, skill unlocks) and send feedback, but can't do
// anything that changes the world: train, rest, use skills or items, shop,
// trade, join/leave houses, build wagons or travel. Raids and hunting already
// check these flags inside their own transactions.

function formatWait(ms) {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Returns an error message if the player is currently locked up, else null.
// Also clears any jail/hospital timer that has already run out.
async function detainedMessage(userId) {
  const stats = await checkStatus(userId);
  const now = Date.now();
  if (stats.inJail) {
    const left = stats.jailUntil ? new Date(stats.jailUntil).getTime() - now : 0;
    return `You are in jail — released in ${formatWait(left)}.`;
  }
  if (stats.inHospital) {
    const left = stats.hospitalUntil ? new Date(stats.hospitalUntil).getTime() - now : 0;
    return `You are in the Infirmary — released in ${formatWait(left)}.`;
  }
  return null;
}

// Route middleware: rejects the request while the player is in jail or hospital.
async function blockIfDetained(req, res, next) {
  if (!req.isAuthenticated()) return next(); // the handler returns the 401
  const hasStats = await prisma.stats.findUnique({ where: { userId: req.user.id }, select: { id: true } });
  if (!hasStats) return next(); // no character yet, nothing to lock
  const msg = await detainedMessage(req.user.id);
  if (msg) return res.status(400).json({ error: msg, detained: true });
  next();
}

app.get('/api/raid/status', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const stats = await checkStatus(req.user.id);
    const now = new Date();
    res.json({
      stats,
      locations:           NPC_LOCATIONS,
      inJail:              stats.inJail,
      jailRemainingMs:     stats.inJail     && stats.jailUntil     ? Math.max(0, stats.jailUntil     - now) : 0,
      inHospital:          stats.inHospital,
      hospitalRemainingMs: stats.inHospital && stats.hospitalUntil ? Math.max(0, stats.hospitalUntil - now) : 0,
    });
  } catch (e) {
    logError('/api/raid/status error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/raid/npc', validate(schemas.raidNpc), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { locationId } = req.body;
  const location = NPC_LOCATIONS.find(l => l.id === locationId);
  if (!location) return res.status(400).json({ error: 'Invalid location' });

  // Clear any expired jail/hospital timers first (idempotent write, benign if racy).
  await checkStatus(req.user.id);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Row-lock this user's Stats row for the whole transaction so concurrent
      // raid requests from the same user fully serialize instead of racing on
      // stale reads (fixes duplicate wins / lost damage / corrupted energy).
      const rows = await tx.$queryRaw`
        SELECT * FROM "Stats" WHERE "userId" = ${req.user.id} FOR UPDATE
      `;
      const stats = rows[0];
      if (!stats) throw { code: 'NO_STATS' };
      if (stats.inJail)     throw { code: 'JAILED' };
      if (stats.inHospital) throw { code: 'HOSPITAL' };
      if (stats.travelDestination) throw { code: 'TRAVELING' };
      if (stats.energy < location.energyCost) throw { code: 'NO_ENERGY' };

      const attackPower  = stats.strength + stats.speed + Math.floor(Math.random() * 15);
      const defensePower = location.difficulty + Math.floor(Math.random() * 10);
      const won          = attackPower >= defensePower;

      const goldGain = won ? Math.floor(Math.random() * (location.goldMax - location.goldMin + 1)) + location.goldMin : 0;
      const xpGain   = won ? location.xpGain : Math.floor(location.xpGain * 0.2);

      const outcomeData = {
        energy: { decrement: location.energyCost },
        xp:     { increment: xpGain },
      };

      let jailMins     = 0;
      let hospitalMins = 0;

      if (won) {
        outcomeData.gold = { increment: goldGain };
      } else {
        const caught = Math.random() < location.jailChance;
        if (caught) {
          jailMins              = location.jailMins;
          outcomeData.inJail    = true;
          outcomeData.jailUntil = new Date(Date.now() + jailMins * 60 * 1000);
        } else {
          hospitalMins = Math.ceil(location.jailMins / 2);
          const newHealth = Math.max(1, stats.health - Math.floor(stats.maxHealth * 0.3));
          outcomeData.health = newHealth;
          if (newHealth <= 10) {
            outcomeData.inHospital    = true;
            outcomeData.hospitalUntil = new Date(Date.now() + hospitalMins * 60 * 1000);
            outcomeData.health        = 1;
          }
        }
      }

      await tx.stats.update({ where: { userId: req.user.id }, data: outcomeData });
      return { won, goldGain, xpGain, jailMins, hospitalMins };
    });

    const levelUp = result.won ? await checkLevelUp(req.user.id) : { leveledUp: false };

    if (result.won) {
      logActivity(req.user.id, 'raid', `Raided ${location.name} — won ${result.goldGain} gold, +${result.xpGain} XP.`);
    } else if (result.jailMins > 0) {
      logActivity(req.user.id, 'raid', `Caught raiding ${location.name} — thrown in jail for ${result.jailMins}m.`);
    } else if (result.hospitalMins > 0) {
      logActivity(req.user.id, 'raid', `Lost the raid at ${location.name} — sent to the Infirmary for ${result.hospitalMins}m.`);
    } else {
      logActivity(req.user.id, 'raid', `Lost the raid at ${location.name}.`);
    }

    res.json({ ...result, location: location.name, ...levelUp });

  } catch (e) {
    if (e && e.code === 'JAILED')    return res.status(400).json({ error: 'You are in jail' });
    if (e && e.code === 'HOSPITAL')  return res.status(400).json({ error: 'You are in the Infirmary' });
    if (e && e.code === 'TRAVELING') return res.status(400).json({ error: 'You are on the road. Finish or turn back from your journey first.' });
    if (e && e.code === 'TARGET_TRAVELING') return res.status(400).json({ error: 'That lord is on the road and out of reach' });
    if (e && e.code === 'NO_ENERGY') return res.status(400).json({ error: 'Not enough energy' });
    logError('/api/raid/npc error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Lords below this level can't attack other players, and can't be attacked.
const PVP_MIN_LEVEL = 5;

app.post('/api/raid/player', validate(schemas.raidPlayer), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { targetId } = req.body;
  if (targetId === req.user.id) return res.status(400).json({ error: 'You cannot attack yourself' });

  // Housemates can't raid each other.
  const [myHouse, theirHouse] = await Promise.all([
    prisma.houseMember.findUnique({ where: { userId: req.user.id }, select: { houseId: true } }),
    prisma.houseMember.findUnique({ where: { userId: targetId },   select: { houseId: true } }),
  ]);
  if (myHouse && theirHouse && myHouse.houseId === theirHouse.houseId) {
    return res.status(400).json({ error: 'You cannot attack a member of your own house' });
  }

  // Clear expired status flags (idempotent, benign if racy).
  await checkStatus(req.user.id);
  await checkStatus(targetId);

  const target = await prisma.user.findUnique({ where: { id: targetId }, include: { stats: true } });
  if (!target || !target.stats) return res.status(404).json({ error: 'Target not found' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock both rows for the duration of the transaction, always in ascending
      // userId order, so two players attacking each other simultaneously can't
      // deadlock and can't interleave on stale reads.
      const ids = [req.user.id, targetId].sort((a, b) => a - b);
      const rows = await tx.$queryRaw`
        SELECT * FROM "Stats" WHERE "userId" IN (${ids[0]}, ${ids[1]}) ORDER BY "userId" FOR UPDATE
      `;
      const attackerStats = rows.find(r => r.userId === req.user.id);
      const defenderStats = rows.find(r => r.userId === targetId);
      if (!attackerStats || !defenderStats) throw { code: 'NO_STATS' };

      if (attackerStats.inJail)     throw { code: 'JAILED' };
      if (attackerStats.inHospital) throw { code: 'HOSPITAL' };
      if (attackerStats.travelDestination) throw { code: 'TRAVELING' };
      if (defenderStats.travelDestination) throw { code: 'TARGET_TRAVELING' };
      if (attackerStats.level < PVP_MIN_LEVEL) throw { code: 'LOW_LEVEL' };
      if (defenderStats.level < PVP_MIN_LEVEL) throw { code: 'TARGET_PROTECTED' };
      if (attackerStats.energy < 20) throw { code: 'NO_ENERGY' };

      // Combat
      const attackPower  = attackerStats.strength + attackerStats.speed     + Math.floor(Math.random() * 20);
      const defensePower = defenderStats.defense   + defenderStats.dexterity + Math.floor(Math.random() * 20);
      const won = attackPower >= defensePower;

      const xpGain     = won ? 30 : 10;
      const goldStolen = won ? Math.floor(defenderStats.gold * (Math.random() * 0.1 + 0.05)) : 0;

      const attackerUpdate = {
        energy: { decrement: 20 },
        xp:     { increment: xpGain },
        gold:   { increment: goldStolen }, // 0 on loss, no harm
      };

      const defenderUpdate = {};
      let defenderHospitalized = false;

      if (won) {
        defenderUpdate.gold = { decrement: goldStolen };
        const newHealth = Math.max(1, defenderStats.health - Math.floor(defenderStats.maxHealth * 0.25));
        defenderUpdate.health = newHealth;
        if (newHealth <= 10) {
          defenderUpdate.inHospital    = true;
          defenderUpdate.hospitalUntil = new Date(Date.now() + 10 * 60 * 1000);
          defenderUpdate.health        = 1;
          defenderHospitalized         = true;
        }
      } else {
        // Attacker loses and is injured.
        const newHealth = Math.max(1, attackerStats.health - Math.floor(attackerStats.maxHealth * 0.2));
        attackerUpdate.health = newHealth;
        if (newHealth <= 10) {
          attackerUpdate.inHospital    = true;
          attackerUpdate.hospitalUntil = new Date(Date.now() + 8 * 60 * 1000);
          attackerUpdate.health        = 1;
        }
      }

      await tx.stats.update({ where: { userId: req.user.id }, data: attackerUpdate });
      if (Object.keys(defenderUpdate).length > 0) {
        await tx.stats.update({ where: { userId: targetId }, data: defenderUpdate });
      }

      return { won, goldStolen, xpGain, defenderHospitalized };
    });

    const levelUp = await checkLevelUp(req.user.id);

    if (result.won) {
      logActivity(req.user.id, 'raid', `Attacked ${target.characterName} and won — stole ${result.goldStolen} gold, +${result.xpGain} XP.`);
      logActivity(targetId, 'raid', `Was attacked by ${req.user.characterName} and lost ${result.goldStolen} gold.${result.defenderHospitalized ? ' Sent to the Infirmary.' : ''}`);
    } else {
      logActivity(req.user.id, 'raid', `Attacked ${target.characterName} and lost, +${result.xpGain} XP.`);
      logActivity(targetId, 'raid', `Successfully defended against an attack from ${req.user.characterName}.`);
    }

    res.json({
      ...result,
      targetName: target.characterName,
      ...levelUp
    });

  } catch (e) {
    if (e && e.code === 'JAILED')    return res.status(400).json({ error: 'You are in jail' });
    if (e && e.code === 'HOSPITAL')  return res.status(400).json({ error: 'You are in the Infirmary' });
    if (e && e.code === 'TRAVELING') return res.status(400).json({ error: 'You are on the road. Finish or turn back from your journey first.' });
    if (e && e.code === 'TARGET_TRAVELING') return res.status(400).json({ error: 'That lord is on the road and out of reach' });
    if (e && e.code === 'LOW_LEVEL') return res.status(400).json({ error: `You must reach level ${PVP_MIN_LEVEL} before you can attack other lords`, minLevel: PVP_MIN_LEVEL });
    if (e && e.code === 'TARGET_PROTECTED') return res.status(400).json({ error: `That lord is under level ${PVP_MIN_LEVEL} and protected from attack`, minLevel: PVP_MIN_LEVEL });
    if (e && e.code === 'NO_ENERGY') return res.status(400).json({ error: 'Not enough energy — attacks cost 20 energy' });
    logError('/api/raid/player error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});






// ─── MONSTERS ─────────────────────────────────────────────────────────────────

// Loot tables — currently only Low tier (Cursed Woods) drops materials.
// Each entry: independent chance roll per item (a monster can drop 0, 1, or
// multiple items on the same kill). Item names must match rows in the Item
// table exactly (see prisma/seed-items.js).
// The Basic Wagon is the first unlock toward inter-city travel. Requires
// Level 10 and enough crafting materials, purchasable from the General
// Store or found in the wild later.
// Wagon progression — 4 tiers. Each tier is gated by level + gold + crafting
// materials, and applies a speedMultiplier to every city's base travelHours
// (see CITIES below). Tier 1 (Basic Wagon) is the minimum needed to travel
// at all; tiers 2-4 are pure quality-of-life upgrades that shorten the trip.
const WAGON_TIERS = [
  {
    tier: 1, name: 'Basic Wagon',
    minLevel: 10, gold: 0,
    materials: [
      { itemName: 'Logs',     qty: 10 },
      { itemName: 'Nails',    qty: 15 },
      { itemName: 'Iron Bar', qty: 5 },
    ],
    speedMultiplier: 1.0,
    desc: 'A rickety cart, but it rolls. Enough to get you off the road out of Aurelia.',
  },
  {
    tier: 2, name: 'Reinforced Wagon',
    minLevel: 20, gold: 500,
    materials: [
      { itemName: 'Logs',     qty: 20 },
      { itemName: 'Nails',    qty: 25 },
      { itemName: 'Iron Bar', qty: 15 },
    ],
    speedMultiplier: 0.7,
    desc: 'Iron-shod wheels and a sturdier frame. Noticeably faster over rough roads.',
  },
  {
    tier: 3, name: 'Swift Wagon',
    minLevel: 35, gold: 2500,
    materials: [
      { itemName: 'Logs',     qty: 30 },
      { itemName: 'Nails',    qty: 40 },
      { itemName: 'Iron Bar', qty: 30 },
    ],
    speedMultiplier: 0.45,
    desc: 'Lighter, tighter, and pulled by a matched team. Built for lords in a hurry.',
  },
  {
    tier: 4, name: 'Royal Caravan',
    minLevel: 50, gold: 10000,
    materials: [
      { itemName: 'Logs',        qty: 40 },
      { itemName: 'Iron Bar',    qty: 50 },
      { itemName: 'Ancient Coin', qty: 10 },
    ],
    speedMultiplier: 0.25,
    desc: 'A royal-grade caravan with a paid escort. The fastest way across Karthûl short of magic.',
  },
];
const WAGON_MIN_LEVEL = WAGON_TIERS[0].minLevel;
const WAGON_RECIPE = WAGON_TIERS[0].materials;

function wagonSpeedMultiplier(tier) {
  const t = WAGON_TIERS.find(w => w.tier === tier);
  return t ? t.speedMultiplier : 1.0;
}

function effectiveTravelHours(baseHours, wagonTier) {
  return Math.max(1, Math.round(baseHours * wagonSpeedMultiplier(wagonTier)));
}

const LOOT_TABLES = {
  'Feral Wolf': [
    { itemName: 'Wolf Pelt',  chance: 0.40, qty: 1 },
    { itemName: 'Wolf Fang',  chance: 0.25, qty: 1 },
    { itemName: 'Wolf Claw',  chance: 0.15, qty: 1 },
    { itemName: 'Minor Healing Potion', chance: 0.05, qty: 1 },
    { itemName: 'Stick', chance: 0.30, qty: 1 },
    { itemName: 'Rock',  chance: 0.30, qty: 1 },
  ],
  'Wild Boar': [
    { itemName: 'Boar Hide', chance: 0.35, qty: 1 },
    { itemName: 'Boar Tusk', chance: 0.20, qty: 1 },
    { itemName: 'Minor Healing Potion', chance: 0.05, qty: 1 },
    { itemName: 'Stick', chance: 0.30, qty: 1 },
    { itemName: 'Rock',  chance: 0.30, qty: 1 },
  ],
  'Bog Goblin': [
    { itemName: 'Goblin Tooth',       chance: 0.40, qty: 1 },
    { itemName: 'Goblin Ear',         chance: 0.20, qty: 1 },
    { itemName: 'Rusty Dagger',       chance: 0.12, qty: 1 },
    { itemName: 'Tattered Coin Pouch', chance: 0.08, qty: 1 },
    { itemName: 'Frying Pan', chance: 0.20, qty: 1 },
    { itemName: 'Rock',       chance: 0.25, qty: 1 },
  ],
  'Giant Rat Swarm': [
    { itemName: 'Rat Tail',     chance: 0.45, qty: 1 },
    { itemName: 'Rat Fur',      chance: 0.25, qty: 1 },
    { itemName: 'Moldy Cheese', chance: 0.15, qty: 1 },
    { itemName: 'Stick', chance: 0.35, qty: 1 },
    { itemName: 'Rock',  chance: 0.20, qty: 1 },
  ],
  'Bandit Scout': [
    { itemName: 'Tattered Coin Pouch', chance: 0.25, qty: 1 },
    { itemName: 'Worn Leather Strap',  chance: 0.20, qty: 1 },
    { itemName: 'Bandit\'s Mask',      chance: 0.10, qty: 1 },
    { itemName: 'Minor Healing Potion', chance: 0.15, qty: 1 },
    { itemName: 'Ancient Coin',        chance: 0.03, qty: 1 },
    { itemName: 'Frying Pan', chance: 0.25, qty: 1 },
    { itemName: 'Stick',      chance: 0.20, qty: 1 },
  ],

  // Medium tier — Blighted Marsh
  'Marsh Wretch': [
    { itemName: 'Rotten Cloth',    chance: 0.40, qty: 1 },
    { itemName: 'Wretch Claw',     chance: 0.20, qty: 1 },
    { itemName: 'Healing Potion',  chance: 0.08, qty: 1 },
  ],
  'Bloated Leech': [
    { itemName: 'Leech Sac',      chance: 0.35, qty: 1 },
    { itemName: 'Slimy Residue',  chance: 0.30, qty: 1 },
    { itemName: 'Energy Draught', chance: 0.08, qty: 1 },
  ],
  'Venomous Serpent': [
    { itemName: 'Serpent Fang',   chance: 0.35, qty: 1 },
    { itemName: 'Snake Skin',     chance: 0.25, qty: 1 },
    { itemName: 'Healing Potion', chance: 0.06, qty: 1 },
  ],
  'Swamp Troll': [
    { itemName: 'Troll Hide',        chance: 0.30, qty: 1 },
    { itemName: 'Troll Tooth',       chance: 0.20, qty: 1 },
    { itemName: 'Elixir of Vigor',   chance: 0.10, qty: 1 },
  ],
  'Drowned Sailor': [
    { itemName: 'Waterlogged Coin Pouch', chance: 0.25, qty: 1 },
    { itemName: 'Rusted Cutlass',         chance: 0.20, qty: 1 },
    { itemName: 'Barnacle Cluster',       chance: 0.30, qty: 1 },
    { itemName: 'Ancient Coin',           chance: 0.05, qty: 1 },
  ],

  // High tier — Frostpeak Ruins
  'Frost Wraith': [
    { itemName: 'Wraith Essence', chance: 0.35, qty: 1 },
    { itemName: 'Frozen Tear',    chance: 0.20, qty: 1 },
    { itemName: 'Elixir of Vigor', chance: 0.08, qty: 1 },
  ],
  'Ruin Golem': [
    { itemName: 'Golem Core',    chance: 0.25, qty: 1 },
    { itemName: 'Rubble Shard',  chance: 0.35, qty: 1 },
    { itemName: 'Ancient Coin',  chance: 0.10, qty: 1 },
  ],
  'Ice Wyrm Whelp': [
    { itemName: 'Wyrm Scale',     chance: 0.30, qty: 1 },
    { itemName: 'Frost Fang',     chance: 0.25, qty: 1 },
    { itemName: 'Healing Potion', chance: 0.08, qty: 1 },
  ],
  'Cursed Knight': [
    { itemName: 'Cursed Rune',           chance: 0.25, qty: 1 },
    { itemName: 'Tarnished Armor Plate', chance: 0.25, qty: 1 },
    { itemName: 'Scroll of Wisdom',      chance: 0.08, qty: 1 },
  ],
  'Frostbound Revenant': [
    { itemName: 'Revenant Chain',   chance: 0.25, qty: 1 },
    { itemName: 'Frostbound Heart', chance: 0.20, qty: 1 },
    { itemName: 'Elixir of Vigor',  chance: 0.10, qty: 1 },
  ],

  // End Game — The Abyssal Rift
  'Rift Stalker': [
    { itemName: 'Rift Shard',      chance: 0.30, qty: 1 },
    { itemName: 'Stalker Claw',    chance: 0.25, qty: 1 },
    { itemName: 'Elixir of Vigor', chance: 0.10, qty: 1 },
  ],
  'Voidbound Horror': [
    { itemName: 'Void Essence', chance: 0.28, qty: 1 },
    { itemName: 'Horror Eye',   chance: 0.20, qty: 1 },
    { itemName: 'Ancient Coin', chance: 0.10, qty: 1 },
  ],
  'Chaos Hydra': [
    { itemName: 'Hydra Scale',     chance: 0.30, qty: 1 },
    { itemName: 'Chaos Fang',      chance: 0.25, qty: 2 },
    { itemName: 'Healing Potion',  chance: 0.10, qty: 1 },
  ],
  'Ancient Lich': [
    { itemName: 'Lich Dust',                chance: 0.28, qty: 1 },
    { itemName: 'Cursed Phylactery Shard',  chance: 0.15, qty: 1 },
    { itemName: 'Scroll of Wisdom',         chance: 0.10, qty: 1 },
  ],
  'Abyssal Devourer': [
    { itemName: 'Abyssal Core',    chance: 0.25, qty: 1 },
    { itemName: 'Devourer Tooth',  chance: 0.25, qty: 1 },
    { itemName: 'Elixir of Vigor', chance: 0.10, qty: 1 },
  ],
  'Maliovre': [
    { itemName: 'Rift Shard',        chance: 0.30, qty: 2 },
    { itemName: 'Ancient Coin',      chance: 0.15, qty: 1 },
    { itemName: 'Maliovre\'s Sigil', chance: 0.10, qty: 1 },
  ],
};

// ─── CITIES ───────────────────────────────────────────────────────────────────
// Static config for the settlements a lord can travel to (see /realm-map).
// Aurelia is the capital and is handled by the existing /dashboard route, so
// it isn't listed here. Every other entry gets its own hub page at
// /city/:id — reachable once the player has built a wagon (see WAGON_RECIPE
// above). shopItemNames reference rows in the Item table (prisma/seed-items.js);
// nearbyZoneIds/nearbyRaidIds cross-reference MONSTER_ZONES and NPC_LOCATIONS
// below purely for flavor — the hunting/raid systems themselves are global
// and not gated by location.
const CITIES = [
  {
    id: 'icewind-citadel', name: 'Icewind Citadel', region: 'Frostreach — The Shivering North',
    tagline: 'A fortress carved into the northern ice, said to guard secrets older than the kingdom itself.',
    lore: 'The Citadel has stood since before the fracturing of Karthûl, its halls cut directly into a glacier that never fully melts. Its garrison answers to no house but its own, trading furs, ironwork, and old grudges with any lord who survives the road north.',
    travelHours: 4, mode: 'road',
    shopItemNames: ['Healing Potion', 'Energy Draught', 'Iron Bar'],
    nearbyZoneIds: ['ruins'],
    nearbyRaidIds: ['manor', 'treasury'],
  },
  {
    id: 'stonehall', name: 'Stonehall', region: 'Silverpeaks — Dwarven Hold',
    tagline: 'A mountain stronghold of the dwarven clans, rich in ore and older grudges.',
    lore: "Carved rather than built, Stonehall's halls run deeper than any outsider has mapped. Its forges never go cold, and its smiths are said to strike a fairer bargain than most lords of the surface — provided you don't ask what they mine for.",
    travelHours: 3, mode: 'road',
    shopItemNames: ['Logs', 'Nails', 'Iron Bar', 'Minor Healing Potion'],
    nearbyZoneIds: ['ruins', 'woods'],
    nearbyRaidIds: ['caravan'],
  },
  {
    id: 'greenwatch', name: 'Greenwatch', region: 'Verdant Wilds — The Emerald Expanse',
    tagline: 'A watchpost on the edge of an endless forest, where rangers keep count of what moves among the trees.',
    lore: "Half garrison, half trading post, Greenwatch exists to keep the forest's dangers on one side of its palisade. Its rangers trade pelts and tonics brewed from herbs no city apothecary would recognize.",
    travelHours: 5, mode: 'road',
    shopItemNames: ['Minor Healing Potion', 'Scroll of Wisdom', 'Logs'],
    nearbyZoneIds: ['woods'],
    nearbyRaidIds: ['village'],
  },
  {
    id: 'tempest-haven', name: 'Tempest Haven', region: 'Stormcoast — Lands of Tempest',
    tagline: 'A harbor town that has weathered a thousand storms, and sailors who claim to have weathered worse.',
    lore: "Ships arrive battered and leave the same way — Tempest Haven's harbor is the only safe anchorage for a hundred miles of coastline that seems to hate ships. Its taverns trade in salvage, rumor, and remedies for the sea-sick.",
    travelHours: 4, mode: 'road',
    shopItemNames: ['Energy Draught', 'Elixir of Vigor', 'Healing Potion'],
    nearbyZoneIds: ['marsh'],
    nearbyRaidIds: ['caravan', 'manor'],
  },
  {
    id: 'sunspear-oasis', name: 'Sunspear Oasis', region: 'Sandscarre — The Endless Dunes',
    tagline: 'The only reliable water for a hundred miles in any direction — and fiercely contested for it.',
    lore: "Every road across Sandscarre bends toward Sunspear eventually, whether its travelers plan it or not. The oasis has changed hands more times than its well-keepers can count, and the current claimants sell water, shade, and healing draughts at a price only the desperate pay twice.",
    travelHours: 5, mode: 'road',
    shopItemNames: ['Minor Healing Potion', 'Healing Potion', 'Energy Draught'],
    nearbyZoneIds: ['woods'],
    nearbyRaidIds: ['village', 'caravan'],
  },
  {
    id: 'bogtimber', name: 'Bogtimber', region: 'Mireveil — The Sunken Wilds',
    tagline: 'A settlement built on stilts above the marsh, where the locals trust the swamp more than strangers.',
    lore: "Bogtimber rises out of the Blighted Marsh on a lattice of blackened pilings, its people long past being unsettled by what surfaces at night. What they can't grow or trap, they distill — mostly into things that are technically medicine.",
    travelHours: 3, mode: 'road',
    shopItemNames: ['Minor Healing Potion', 'Elixir of Vigor', 'Scroll of Wisdom'],
    nearbyZoneIds: ['marsh'],
    nearbyRaidIds: ['village'],
  },
  {
    id: 'blackgate', name: 'Blackgate', region: 'Ashenreach — Land of Fire and Fury',
    tagline: 'A town living in the shadow of an active volcano, out of necessity rather than choice.',
    lore: "Ash falls on Blackgate more days than not, and its people have simply stopped sweeping it away. What the volcano doesn't threaten to destroy, it provides for — the region's ironwork is unmatched, tempered in heat no forge could replicate.",
    travelHours: 4, mode: 'road',
    shopItemNames: ['Iron Bar', 'Nails', 'Healing Potion'],
    nearbyZoneIds: ['rift'],
    nearbyRaidIds: ['manor', 'treasury'],
  },
  {
    id: 'luminara', name: 'Luminara', region: 'Celestial Isles — Pearls of the South',
    tagline: 'A glittering archipelago city, as beautiful as it is difficult to reach.',
    lore: "Luminara is spread across a dozen linked islets, its bridges and lantern-towers visible for miles out to sea. Reaching it takes a voyage most lords never attempt twice, but its markets deal in comforts and cures found nowhere else in Karthûl.",
    travelHours: 3, mode: 'sea',
    shopItemNames: ['Elixir of Vigor', 'Scroll of Wisdom', 'Energy Draught'],
    nearbyZoneIds: [],
    nearbyRaidIds: [],
  },
];

// ─── TRAVEL ───────────────────────────────────────────────────────────────────
// Aurelia, the capital, is home (Stats.currentCityId = null). A trip takes real
// time: leaving Aurelia, or going city to city, takes the destination's
// travelHours; coming home takes the current city's. Better wagons shorten
// every trip (effectiveTravelHours). The journey lives in travelDestination /
// travelStartedAt / travelArrivesAt, and the server clock decides arrival:
// whichever request comes in after travelArrivesAt settles it (settleTravel).
// While on the road a lord can't hunt, raid or attack, and can't be attacked.
const HOME_ID = 'aurelia';
const HOME = { id: HOME_ID, name: 'Aurelia', region: 'Eldric Kingdoms — Heart of Civilization', mode: 'road' };

function placeById(id) {
  if (id === HOME_ID) return HOME;
  return CITIES.find(c => c.id === id) || null;
}
function placeName(cityId) {
  return cityId ? (placeById(cityId)?.name || cityId) : HOME.name;
}
// The leg that sets the trip's length and mode: the destination's, or the
// city you're leaving when heading home.
function tripLeg(fromCityId, toId) {
  return toId === HOME_ID ? CITIES.find(c => c.id === fromCityId) : placeById(toId);
}
function tripHours(fromCityId, toId, wagonTier) {
  const leg = tripLeg(fromCityId, toId);
  return effectiveTravelHours(leg ? leg.travelHours : 1, wagonTier);
}

// Finishes a journey whose arrival time has passed. Returns the place id the
// player just arrived at, or null if nothing changed.
async function settleTravel(userId) {
  const now = new Date();
  const s = await prisma.stats.findUnique({
    where: { userId },
    select: { travelDestination: true, travelArrivesAt: true },
  });
  if (!s?.travelDestination || !s.travelArrivesAt || s.travelArrivesAt > now) return null;
  const dest = s.travelDestination;
  const done = await prisma.stats.updateMany({
    where: { userId, travelDestination: dest, travelArrivesAt: { lte: now } },
    data:  { currentCityId: dest === HOME_ID ? null : dest, travelDestination: null, travelStartedAt: null, travelArrivesAt: null },
  });
  if (done.count === 0) return null; // another request settled it first
  logActivity(userId, 'travel', `Arrived at ${placeName(dest === HOME_ID ? null : dest)}.`);
  return dest;
}

function travelStatusBody(stats) {
  const dest = placeById(stats.travelDestination);
  const startedAt = new Date(stats.travelStartedAt), arrivesAt = new Date(stats.travelArrivesAt);
  return {
    traveling: true,
    cityId:    stats.travelDestination,
    name:      dest?.name || stats.travelDestination,
    region:    dest?.region || '',
    mode:      tripLeg(stats.currentCityId, stats.travelDestination)?.mode || 'road',
    fromId:    stats.currentCityId || HOME_ID,
    fromName:  placeName(stats.currentCityId),
    startedAt, arrivesAt,
    totalMs:   arrivesAt - startedAt,
    remainingMs: Math.max(0, arrivesAt - Date.now()),
  };
}

const MONSTER_ZONES = [
  {
    id: 'woods',
    name: 'Cursed Woods',
    tier: 'LOW',
    desc: 'A shadowed forest on the edge of the realm. Wolves and goblins prowl the treeline.',
    levelMin: 1,
    levelMax: 10,
    energyCost: 15,
    monsters: [
      { name: 'Feral Wolf',    hpBase: 35, atkBase: 5, defBase: 1 },
      { name: 'Bog Goblin',    hpBase: 45, atkBase: 6, defBase: 2 },
      { name: 'Giant Rat Swarm', hpBase: 25, atkBase: 4, defBase: 0 },
      { name: 'Bandit Scout',  hpBase: 50, atkBase: 7, defBase: 3 },
      { name: 'Wild Boar',     hpBase: 40, atkBase: 6, defBase: 2 },
    ],
  },
  {
    id: 'marsh',
    name: 'Blighted Marsh',
    tier: 'MEDIUM',
    desc: 'Sickly waters hide things that used to be human. The air itself feels hostile.',
    levelMin: 8,
    levelMax: 20,
    energyCost: 22,
    monsters: [
      { name: 'Marsh Wretch',   hpBase: 70,  atkBase: 9,  defBase: 4 },
      { name: 'Bloated Leech',  hpBase: 90,  atkBase: 7,  defBase: 6 },
      { name: 'Venomous Serpent', hpBase: 65, atkBase: 11, defBase: 3 },
      { name: 'Swamp Troll',    hpBase: 110, atkBase: 10, defBase: 7 },
      { name: 'Drowned Sailor', hpBase: 80,  atkBase: 9,  defBase: 5 },
    ],
  },
  {
    id: 'ruins',
    name: 'Frostpeak Ruins',
    tier: 'HIGH',
    desc: 'The frozen remains of a fallen kingdom. Something still guards its halls.',
    levelMin: 18,
    levelMax: 35,
    energyCost: 30,
    monsters: [
      { name: 'Frost Wraith',       hpBase: 140, atkBase: 14, defBase: 8 },
      { name: 'Ruin Golem',         hpBase: 180, atkBase: 12, defBase: 12 },
      { name: 'Ice Wyrm Whelp',     hpBase: 160, atkBase: 16, defBase: 9 },
      { name: 'Cursed Knight',      hpBase: 170, atkBase: 15, defBase: 11 },
      { name: 'Frostbound Revenant', hpBase: 150, atkBase: 17, defBase: 8 },
    ],
  },
  {
    id: 'rift',
    name: 'The Abyssal Rift',
    tier: 'END GAME',
    desc: 'A tear in the world where nightmares crawl through. Only the strongest lords return.',
    levelMin: 30,
    levelMax: 50,
    energyCost: 40,
    monsters: [
      { name: 'Rift Stalker',      hpBase: 240, atkBase: 20, defBase: 14 },
      { name: 'Voidbound Horror',  hpBase: 300, atkBase: 18, defBase: 18 },
      { name: 'Chaos Hydra',       hpBase: 280, atkBase: 22, defBase: 16 },
      { name: 'Ancient Lich',      hpBase: 260, atkBase: 24, defBase: 13 },
      { name: 'Abyssal Devourer',  hpBase: 340, atkBase: 21, defBase: 20 },
      { name: 'Maliovre',          hpBase: 360, atkBase: 23, defBase: 19 },
    ],
  },
];

// Threshold below which a losing fighter is considered defeated (mirrors raid hospital logic).
const COMBAT_DEFEAT_HEALTH = 10;

// Zone gating: a player must reach a zone's levelMin to hunt there, and
// monsters spawn at most this many levels above the player (still within the
// zone's own range), so a new lord isn't thrown at a level-10 wolf.
const MONSTER_LEVEL_LEAD = 3;

function monsterLevelRange(zone, playerLevel) {
  const max = Math.min(zone.levelMax, Math.max(zone.levelMin, playerLevel + MONSTER_LEVEL_LEAD));
  return { min: zone.levelMin, max };
}

function scaleMonster(template, level) {
  return {
    name:      template.name,
    level,
    maxHealth: template.hpBase + level * 8,
    attack:    template.atkBase + level * 2,
    defense:   template.defBase + Math.floor(level * 1.2),
    goldReward: 10 + level * 4,
    xpReward:   8 + level * 3,
  };
}

const feedbackCooldowns = new Map(); // userId -> last submission timestamp
const FEEDBACK_COOLDOWN_MS = 60 * 1000; // 1 submission per minute per user

app.post('/api/feedback', validate(schemas.feedback), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });

  const { category, message } = req.body;

  const lastSent = feedbackCooldowns.get(req.user.id);
  if (lastSent && Date.now() - lastSent < FEEDBACK_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Please wait a moment before sending more feedback.' });
  }

  // Save to the admin feedback inbox first, then email as before. As long as
  // one of the two works, the player's feedback isn't lost.
  let saved = false;
  try {
    await prisma.feedback.create({ data: { userId: req.user.id, category, message } });
    saved = true;
  } catch (err) {
    logError('Feedback save error:', err);
  }

  const result = await sendFeedbackEmail({
    category,
    message,
    username: req.user.characterName || req.user.username,
    email: req.user.email,
  });

  if (!result.ok && !saved) {
    return res.status(500).json({ error: 'Could not send your feedback right now. Please try again later.' });
  }

  feedbackCooldowns.set(req.user.id, Date.now());
  logActivity(req.user.id, 'feedback', `Submitted ${category.toLowerCase()}.`);
  res.json({ ok: true });
});

app.get('/api/wagon/status', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
    if (!stats) return res.status(404).json({ error: 'No stats found' });

    const inventory = await prisma.inventory.findMany({
      where: { userId: req.user.id },
      include: { item: true },
    });

    const currentTier = stats.wagonTier || 0;
    const nextTierConfig = WAGON_TIERS.find(w => w.tier === currentTier + 1);

    const tiers = WAGON_TIERS.map(w => {
      const owned = w.tier <= currentTier;
      const isNext = w.tier === currentTier + 1;
      const progress = isNext ? w.materials.map(req_ => {
        const have = inventory.find(inv => inv.item.name === req_.itemName)?.quantity || 0;
        return { itemName: req_.itemName, need: req_.qty, have: Math.min(have, req_.qty) };
      }) : undefined;
      return {
        tier: w.tier, name: w.name, desc: w.desc,
        minLevel: w.minLevel, gold: w.gold, materials: w.materials,
        speedMultiplier: w.speedMultiplier,
        owned, isNext, progress,
      };
    });

    res.json({
      hasWagon: currentTier >= 1,
      wagonTier: currentTier,
      level: stats.level,
      gold: stats.gold,
      tiers,
      canUpgrade: !!nextTierConfig
        && stats.level >= nextTierConfig.minLevel
        && stats.gold >= nextTierConfig.gold
        && nextTierConfig.materials.every(req_ => {
          const have = inventory.find(inv => inv.item.name === req_.itemName)?.quantity || 0;
          return have >= req_.qty;
        }),
    });
  } catch (e) {
    logError('/api/wagon/status error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Builds the Basic Wagon (tier 1) or upgrades to the next tier — same flow,
// since each tier is just "the next thing you don't have yet".
app.post('/api/wagon/build', blockIfDetained, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });

  try {
    await prisma.$transaction(async (tx) => {
      const statsRows = await tx.$queryRaw`
        SELECT * FROM "Stats" WHERE "userId" = ${req.user.id} FOR UPDATE
      `;
      const stats = statsRows[0];
      if (!stats) throw { code: 'NO_STATS' };

      const currentTier = stats.wagonTier || 0;
      const nextTier = WAGON_TIERS.find(w => w.tier === currentTier + 1);
      if (!nextTier) throw { code: 'MAX_TIER' };
      if (stats.level < nextTier.minLevel) throw { code: 'LEVEL_TOO_LOW', minLevel: nextTier.minLevel };
      if (stats.gold < nextTier.gold) throw { code: 'NOT_ENOUGH_GOLD', gold: nextTier.gold };

      // Verify and consume each required material.
      for (const req_ of nextTier.materials) {
        const item = await tx.item.findFirst({ where: { name: req_.itemName } });
        if (!item) throw { code: 'MISSING_ITEM', itemName: req_.itemName };

        const inv = await tx.inventory.findFirst({ where: { userId: req.user.id, itemId: item.id } });
        if (!inv || inv.quantity < req_.qty) throw { code: 'NOT_ENOUGH', itemName: req_.itemName };
      }
      for (const req_ of nextTier.materials) {
        const item = await tx.item.findFirst({ where: { name: req_.itemName } });
        const inv = await tx.inventory.findFirst({ where: { userId: req.user.id, itemId: item.id } });
        if (inv.quantity - req_.qty <= 0) {
          await tx.inventory.delete({ where: { id: inv.id } });
        } else {
          await tx.inventory.update({ where: { id: inv.id }, data: { quantity: { decrement: req_.qty } } });
        }
      }

      await tx.stats.update({
        where: { userId: req.user.id },
        data: {
          wagonTier: nextTier.tier,
          hasWagon: true,
          gold: { decrement: nextTier.gold },
        },
      });

      req._builtTierName = nextTier.name;
    });

    logActivity(req.user.id, 'level', `Acquired the ${req._builtTierName}! Travel across Karthûl just got faster.`);
    res.json({ ok: true });

  } catch (e) {
    if (e && e.code === 'MAX_TIER')        return res.status(400).json({ error: 'You already own the best wagon available' });
    if (e && e.code === 'LEVEL_TOO_LOW')   return res.status(400).json({ error: `You must be at least Level ${e.minLevel} for this wagon` });
    if (e && e.code === 'NOT_ENOUGH_GOLD') return res.status(400).json({ error: `You need ${e.gold} gold for this wagon` });
    if (e && e.code === 'NOT_ENOUGH')      return res.status(400).json({ error: `Not enough ${e.itemName}` });
    if (e && e.code === 'MISSING_ITEM')    return res.status(500).json({ error: `${e.itemName} is not yet available — ask the developer to seed it` });
    logError('/api/wagon/build error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/cities', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
    const wagonTier = stats?.wagonTier || 0;
    res.json({
      hasWagon: !!stats?.hasWagon,
      wagonTier,
      cities: CITIES.map(c => ({
        id: c.id, name: c.name, region: c.region, tagline: c.tagline,
        travelHours: effectiveTravelHours(c.travelHours, wagonTier), mode: c.mode,
      })),
    });
  } catch (e) {
    logError('/api/cities error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/cities/:cityId', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const city = CITIES.find(c => c.id === req.params.cityId);
  if (!city) return res.status(404).json({ error: 'Unknown settlement' });

  try {
    await settleTravel(req.user.id);
    const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
    const wagonTier = stats?.wagonTier || 0;
    const shopItems = await prisma.item.findMany({
      where: { name: { in: city.shopItemNames } },
      orderBy: { basePrice: 'asc' },
    });
    const nearbyZones = MONSTER_ZONES
      .filter(z => city.nearbyZoneIds.includes(z.id))
      .map(z => ({ id: z.id, name: z.name, tier: z.tier, desc: z.desc, levelMin: z.levelMin, levelMax: z.levelMax }));
    const nearbyRaids = NPC_LOCATIONS
      .filter(l => city.nearbyRaidIds.includes(l.id))
      .map(l => ({ id: l.id, name: l.name, risk: l.risk, desc: l.desc }));

    // Opening a city page never moves the player; travel does (see TRAVEL).

    res.json({
      id: city.id,
      name: city.name,
      region: city.region,
      tagline: city.tagline,
      lore: city.lore,
      travelHours: effectiveTravelHours(city.travelHours, wagonTier),
      mode: city.mode,
      hasWagon: !!stats?.hasWagon,
      wagonTier,
      currentCityId: stats?.currentCityId ?? null,
      here:          !!stats && !stats.travelDestination && stats.currentCityId === city.id,
      travelingTo:   stats?.travelDestination ?? null,
      tripHours:     tripHours(stats?.currentCityId ?? null, city.id, wagonTier),
      shopItems,
      nearbyZones,
      nearbyRaids,
    });
  } catch (e) {
    logError('/api/cities/:cityId error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Where the player is, or the journey they're on. `arrived` is true only on the
// request that settled an arrival, so the traveling page can show it once.
app.get('/api/travel/status', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const arrived = await settleTravel(req.user.id);
    const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
    if (!stats) return res.status(400).json({ error: 'Finish creating your character first.' });
    if (stats.travelDestination) return res.json(travelStatusBody(stats));
    const here = stats.currentCityId || HOME_ID;
    res.json({ traveling: false, arrived: !!arrived, cityId: here, name: placeName(stats.currentCityId) });
  } catch (e) {
    logError('/api/travel/status error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/travel/start', validate(schemas.travelStart), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const dest = placeById(req.body.cityId);
  if (!dest) return res.status(404).json({ error: 'Unknown settlement' });
  try {
    const hasStats = await prisma.stats.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!hasStats) return res.status(400).json({ error: 'Finish creating your character first.' });
    const stats = await checkStatus(req.user.id); // settles any finished trip, clears expired timers
    if (stats.travelDestination) {
      return res.status(400).json({ error: `You are already on the road to ${placeName(stats.travelDestination)}`, travelDestination: stats.travelDestination });
    }
    const here = stats.currentCityId || HOME_ID;
    if (here === dest.id) return res.status(400).json({ error: `You are already in ${dest.name}`, alreadyThere: true, cityId: dest.id });
    if (stats.inJail)     return res.status(400).json({ error: 'You are in jail' });
    if (stats.inHospital) return res.status(400).json({ error: 'You are in the Infirmary' });
    if (dest.id !== HOME_ID && !stats.hasWagon) return res.status(400).json({ error: 'You need a wagon to travel that far. Build one on the Realm Map.' });
    const fight = await prisma.combatSession.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (fight) return res.status(400).json({ error: 'Finish or flee your fight before setting out' });

    const hours = tripHours(stats.currentCityId, dest.id, stats.wagonTier || 0);
    const startedAt = new Date();
    const arrivesAt = new Date(startedAt.getTime() + hours * 60 * 60 * 1000);
    const started = await prisma.stats.updateMany({
      where: { userId: req.user.id, travelDestination: null },
      data:  { travelDestination: dest.id, travelStartedAt: startedAt, travelArrivesAt: arrivesAt },
    });
    if (started.count === 0) return res.status(409).json({ error: 'You are already on the road' });
    logActivity(req.user.id, 'travel', `Set out from ${placeName(stats.currentCityId)} for ${dest.name} (~${hours}h).`);
    const fresh = await prisma.stats.findUnique({ where: { userId: req.user.id } });
    res.json({ ok: true, hours, ...travelStatusBody(fresh) });
  } catch (e) {
    logError('/api/travel/start error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Turn back: the journey is abandoned and the player stays where they started.
app.post('/api/travel/cancel', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const arrived = await settleTravel(req.user.id);
    if (arrived) return res.status(400).json({ error: `You have already arrived at ${placeName(arrived === HOME_ID ? null : arrived)}` });
    const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
    if (!stats?.travelDestination) return res.status(400).json({ error: 'You are not traveling' });
    await prisma.stats.updateMany({
      where: { userId: req.user.id, travelDestination: stats.travelDestination },
      data:  { travelDestination: null, travelStartedAt: null, travelArrivesAt: null },
    });
    logActivity(req.user.id, 'travel', `Turned back on the road to ${placeName(stats.travelDestination)}.`);
    res.json({ ok: true, cityId: stats.currentCityId || HOME_ID });
  } catch (e) {
    logError('/api/travel/cancel error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Kept for older clients: heading home is now a journey like any other.
app.post('/api/travel/home', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  res.status(400).json({ error: 'Returning to Aurelia takes a journey now. Use the Realm Map.', useTravel: true });
});

app.get('/api/activity', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  try {
    const entries = await prisma.activityLog.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ entries });
  } catch (e) {
    logError('/api/activity error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/wiki', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });

  try {
    const classes = Object.entries(CLASSES).map(([key, c]) => ({
      key, label: c.label, desc: c.desc,
      baseStats: c.baseStats, perLevel: c.perLevel,
    }));

    const skills = Object.entries(SKILL_TREES).map(([classKey, tree]) => ({
      classKey,
      classLabel: CLASSES[classKey]?.label || classKey,
      skills: tree.map(s => ({
        key: s.key, name: s.name, cost: s.cost, requires: s.requires,
        type: s.type, desc: s.desc,
      })),
    }));

    const zones = MONSTER_ZONES.map(z => ({
      id: z.id, name: z.name, tier: z.tier, desc: z.desc,
      levelMin: z.levelMin, levelMax: z.levelMax, energyCost: z.energyCost,
      monsters: z.monsters.map(m => ({
        name: m.name, hpBase: m.hpBase, atkBase: m.atkBase, defBase: m.defBase,
        loot: (LOOT_TABLES[m.name] || []).map(l => ({
          itemName: l.itemName, chance: l.chance, qty: l.qty,
        })),
      })),
    }));

    const raidLocations = NPC_LOCATIONS.map(l => ({
      id: l.id, name: l.name, risk: l.risk, desc: l.desc,
      energyCost: l.energyCost, goldMin: l.goldMin, goldMax: l.goldMax,
      xpGain: l.xpGain, jailChance: l.jailChance, jailMins: l.jailMins,
    }));

    const items = await prisma.item.findMany({ orderBy: [{ type: 'asc' }, { basePrice: 'asc' }] });

    const mechanics = {
      energyRegen:  { amount: ENERGY_REGEN_AMOUNT, intervalMinutes: ENERGY_REGEN_INTERVAL_MS / 60000 },
      trainingCooldownMinutes: TRAINING_COOLDOWN_MS / 60000,
      restCooldownMinutes: REST_COOLDOWN_MS / 60000,
    };

    res.json({ classes, skills, zones, raidLocations, items, mechanics });
  } catch (e) {
    logError('/api/wiki error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/monsters/zones', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id }, select: { level: true } });
  const playerLevel = stats?.level ?? 1;
  res.json({ zones: MONSTER_ZONES.map(z => {
    const range = monsterLevelRange(z, playerLevel);
    return {
      id: z.id, name: z.name, tier: z.tier, desc: z.desc,
      levelMin: z.levelMin, levelMax: z.levelMax, energyCost: z.energyCost,
      locked: playerLevel < z.levelMin,       // can't hunt here yet
      foeLevelMin: range.min, foeLevelMax: range.max, // what this player will actually meet
    };
  }) });
});

app.get('/api/monsters/session', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const session = await prisma.combatSession.findUnique({ where: { userId: req.user.id } });
  res.json({ session });
});

app.post('/api/monsters/start', validate(schemas.monstersStart), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { zoneId } = req.body;
  const zone = MONSTER_ZONES.find(z => z.id === zoneId);
  if (!zone) return res.status(400).json({ error: 'Invalid zone' });

  await checkStatus(req.user.id);

  const existing = await prisma.combatSession.findUnique({ where: { userId: req.user.id } });
  if (existing) return res.status(400).json({ error: 'You are already in a fight. Finish or flee first.' });

  try {
    const session = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT * FROM "Stats" WHERE "userId" = ${req.user.id} FOR UPDATE
      `;
      const stats = rows[0];
      if (!stats) throw { code: 'NO_STATS' };
      if (stats.inJail)     throw { code: 'JAILED' };
      if (stats.inHospital) throw { code: 'HOSPITAL' };
      if (stats.travelDestination) throw { code: 'TRAVELING' };
      if (stats.level < zone.levelMin) throw { code: 'LEVEL_TOO_LOW', minLevel: zone.levelMin };
      if (stats.energy < zone.energyCost) throw { code: 'NO_ENERGY' };

      await tx.stats.update({
        where: { userId: req.user.id },
        data: { energy: { decrement: zone.energyCost } },
      });

      const template = zone.monsters[Math.floor(Math.random() * zone.monsters.length)];
      const range = monsterLevelRange(zone, stats.level);
      const level = range.min + Math.floor(Math.random() * (range.max - range.min + 1));
      const monster = scaleMonster(template, level);

      return tx.combatSession.create({
        data: {
          userId:           req.user.id,
          zoneId:           zone.id,
          monsterName:      monster.name,
          monsterLevel:      monster.level,
          monsterMaxHealth: monster.maxHealth,
          monsterHealth:    monster.maxHealth,
          monsterAttack:    monster.attack,
          monsterDefense:   monster.defense,
        },
      });
    });

    res.json({ session });
  } catch (e) {
    if (e && e.code === 'JAILED')    return res.status(400).json({ error: 'You are in jail' });
    if (e && e.code === 'HOSPITAL')  return res.status(400).json({ error: 'You are in the Infirmary' });
    if (e && e.code === 'LEVEL_TOO_LOW') return res.status(400).json({ error: `You must be at least Level ${e.minLevel} to hunt in ${zone.name}` });
    if (e && e.code === 'TRAVELING') return res.status(400).json({ error: 'You are on the road. Finish or turn back from your journey first.' });
    if (e && e.code === 'TARGET_TRAVELING') return res.status(400).json({ error: 'That lord is on the road and out of reach' });
    if (e && e.code === 'NO_ENERGY') return res.status(400).json({ error: 'Not enough energy' });
    logError('/api/monsters/start error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/monsters/turn', validate(schemas.monstersTurn), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { action } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock both the session and the stats row so concurrent turn spam
      // can't double-apply damage or race the win/loss check.
      const statsRows = await tx.$queryRaw`
        SELECT * FROM "Stats" WHERE "userId" = ${req.user.id} FOR UPDATE
      `;
      const stats = statsRows[0];
      if (!stats) throw { code: 'NO_STATS' };

      const sessionRows = await tx.$queryRaw`
        SELECT * FROM "CombatSession" WHERE "userId" = ${req.user.id} FOR UPDATE
      `;
      const session = sessionRows[0];
      if (!session) throw { code: 'NO_SESSION' };

      if (action === 'flee') {
        await tx.combatSession.delete({ where: { userId: req.user.id } });
        return { fled: true };
      }

      const log = [];
      let monsterHealth = session.monsterHealth;
      let playerHealth   = stats.health;

      // Player's turn
      if (action === 'attack') {
        const dmg = Math.max(1, stats.strength + Math.floor(Math.random() * 10) - session.monsterDefense);
        monsterHealth = Math.max(0, monsterHealth - dmg);
        log.push({ actor: 'player', action: 'attack', amount: dmg });
      } else {
        log.push({ actor: 'player', action: 'defend', amount: 0 });
      }

      // Check for victory before the monster retaliates
      if (monsterHealth <= 0) {
        const goldReward = 10 + session.monsterLevel * 4 + Math.floor(Math.random() * 10);
        const xpReward   = 8 + session.monsterLevel * 3;

        await tx.stats.update({
          where: { userId: req.user.id },
          data: { gold: { increment: goldReward }, xp: { increment: xpReward } },
        });

        // Roll loot drops, if this monster has a loot table.
        const drops = [];
        const table = LOOT_TABLES[session.monsterName];
        if (table) {
          for (const entry of table) {
            if (Math.random() < entry.chance) {
              const item = await tx.item.findFirst({ where: { name: entry.itemName } });
              if (!item) continue; // item not seeded yet — skip rather than crash
              const existing = await tx.inventory.findFirst({ where: { userId: req.user.id, itemId: item.id } });
              if (existing) {
                await tx.inventory.update({ where: { id: existing.id }, data: { quantity: { increment: entry.qty } } });
              } else {
                await tx.inventory.create({ data: { userId: req.user.id, itemId: item.id, quantity: entry.qty } });
              }
              drops.push({ name: item.name, qty: entry.qty });
            }
          }
        }

        await tx.combatSession.delete({ where: { userId: req.user.id } });

        return { won: true, log, goldReward, xpReward, drops, monsterName: session.monsterName };
      }

      // Monster's turn
      let monsterDmg = Math.max(1, session.monsterAttack + Math.floor(Math.random() * 6) - stats.defense);
      if (action === 'defend') monsterDmg = Math.ceil(monsterDmg / 2);
      playerHealth = Math.max(0, playerHealth - monsterDmg);
      log.push({ actor: 'monster', action: 'attack', amount: monsterDmg });

      // Defeat check
      if (playerHealth <= COMBAT_DEFEAT_HEALTH) {
        const hospitalMins = 5 + Math.ceil(session.monsterLevel / 5);
        await tx.stats.update({
          where: { userId: req.user.id },
          data: {
            health:        1,
            inHospital:    true,
            hospitalUntil: new Date(Date.now() + hospitalMins * 60 * 1000),
          },
        });
        await tx.combatSession.delete({ where: { userId: req.user.id } });

        return { lost: true, log, hospitalMins, monsterName: session.monsterName };
      }

      // Fight continues — persist both updated health values
      await tx.stats.update({ where: { userId: req.user.id }, data: { health: playerHealth } });
      const updatedSession = await tx.combatSession.update({
        where: { userId: req.user.id },
        data: { monsterHealth, turnCount: { increment: 1 } },
      });

      return { ongoing: true, log, session: updatedSession, playerHealth };
    });

    if (result.won) {
      const levelUp = await checkLevelUp(req.user.id);
      let msg = `Defeated ${result.monsterName} — ${result.goldReward} gold, +${result.xpReward} XP.`;
      if (result.drops && result.drops.length) {
        msg += ` Found: ${result.drops.map(d => `${d.qty}x ${d.name}`).join(', ')}.`;
      }
      logActivity(req.user.id, 'monster', msg);
      return res.json({ ...result, ...levelUp });
    }
    if (result.lost) {
      logActivity(req.user.id, 'monster', `Defeated by ${result.monsterName} — sent to the Infirmary for ${result.hospitalMins}m.`);
    }
    if (result.fled) {
      logActivity(req.user.id, 'monster', `Fled from a fight.`);
    }
    res.json(result);

  } catch (e) {
    if (e && e.code === 'NO_SESSION') return res.status(400).json({ error: 'No fight in progress' });
    logError('/api/monsters/turn error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── Admin panel ──────────────────────────────────────────────────────────────

admin.registerAnnouncementRoute(app, { prisma, logError });
admin.registerAdminRoutes(app, { prisma, logError, validate, CLASSES });
admin.startBackgroundJobs({ prisma, logError });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Clans vs Society is running on port ${PORT}`);
});
