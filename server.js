require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

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
    desc: 'Swift and sure. Earns more on the road and tires less quickly.',
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
    desc: 'Lurks in shadow. Patrol may yield double gold on a lucky strike.',
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
    desc: 'Words are their weapon. Earns bonus XP everywhere and may charm extra coin on patrol.',
  },
};

const VALID_CLASSES = Object.keys(CLASSES);

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
      desc:     'Your reputation precedes you. Patrol yields 20% more gold.',
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
      desc:     'You know every shortcut. Patrol costs 5 less energy.',
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
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));
app.use(passport.initialize());
app.use(passport.session());

// ─── Passport ─────────────────────────────────────────────────────────────────

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.CALLBACK_URL || '/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const user = await prisma.user.upsert({
      where:  { googleId: profile.id },
      update: {
        lastLoginAt: new Date(),
        avatar:      profile.photos?.[0]?.value || null,
        googleName:  profile.displayName         || null,
        email:       profile.emails?.[0]?.value  || null,
      },
      create: {
        googleId:   profile.id,
        username:   profile.displayName,
        googleName: profile.displayName         || null,
        email:      profile.emails?.[0]?.value  || null,
        avatar:     profile.photos?.[0]?.value  || null,
      },
    });
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
    console.error('[deserializeUser] error for id', id, err);
    done(err, null);
  }
});

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
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
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'raids.html'));
});

app.get('/monsters', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'monsters.html'));
});

app.get('/house', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'house.html'));
});

app.get('/realm-map', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'realm-map.html'));
});

app.get('/market', (req, res) => {
  if (!req.isAuthenticated())   return res.redirect('/');
  if (!req.user.characterName)  return res.redirect('/choose-name');
  if (!req.user.characterClass) return res.redirect('/choose-class');
  res.sendFile(path.join(__dirname, 'public', 'market.html'));
});
// ─── API: auth ────────────────────────────────────────────────────────────────

app.post('/api/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });
});

// ─── API: player data ─────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const stats      = req.user.stats;
  const now        = Date.now();
  const lastRestAt = stats?.lastRestAt;
  const lastEnergyAt = stats?.lastEnergyAt;

  const restCooldownMs = lastRestAt
    ? Math.max(0, new Date(lastRestAt).getTime() + REST_COOLDOWN_MS - now)
    : 0;

  // How many ms until the next energy tick (for UI countdown)
  const nextEnergyTickMs = lastEnergyAt && stats.energy < stats.maxEnergy
    ? Math.max(0, new Date(lastEnergyAt).getTime() + ENERGY_REGEN_INTERVAL_MS - now)
    : null;

  res.json({
    username:        req.user.characterName || req.user.username,
    googleName:      req.user.googleName,
    email:           req.user.email,
    avatar:          req.user.avatar,
    characterClass:  req.user.characterClass,
    classLabel:      req.user.characterClass ? CLASSES[req.user.characterClass].label : null,
    lastLoginAt:     req.user.lastLoginAt,
    createdAt:       req.user.createdAt,
    stats,
    restCooldownMs,
    energyRegen: {
      amount:       ENERGY_REGEN_AMOUNT,
      intervalMs:   ENERGY_REGEN_INTERVAL_MS,
      nextTickMs:   nextEnergyTickMs,
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

app.post('/api/choose-name', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { characterName } = req.body;
  if (!characterName || characterName.trim().length < 2)
    return res.status(400).json({ error: 'Name must be at least 2 characters' });
  const clean = characterName.trim().slice(0, 24);
  try {
    const exists = await prisma.user.findFirst({ where: { characterName: clean } });
    if (exists) return res.status(409).json({ error: 'That name is already taken' });
    await prisma.user.update({ where: { id: req.user.id }, data: { characterName: clean } });

    // Refresh session so the new characterName is visible immediately.
    const updatedUser = await prisma.user.findUnique({
      where:   { id: req.user.id },
      include: { stats: true },
    });
    req.login(updatedUser, (err) => {
      if (err) return res.status(500).json({ error: 'Session refresh failed' });
      res.json({ ok: true });
    });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── API: choose class ────────────────────────────────────────────────────────

app.post('/api/choose-class', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  if (req.user.characterClass)  return res.status(409).json({ error: 'Class already chosen' });

  const { characterClass } = req.body;
  if (!VALID_CLASSES.includes(characterClass))
    return res.status(400).json({ error: 'Invalid class' });

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
    console.error(e);
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

app.post('/api/action/patrol', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { characterClass } = req.user;

  // Pathfinder (RANGER_3): patrol costs 5 less energy
  let baseCost = 10;
  if (characterClass === 'RANGER' && await hasSkill(req.user.id, 'RANGER_3')) {
    baseCost = Math.max(0, baseCost - 5);
  }
  const cost = await energyCost(baseCost, characterClass, req.user.id);

  // Atomically deduct energy. If the row doesn't match (insufficient energy) count === 0.
  const deducted = await prisma.stats.updateMany({
    where: { userId: req.user.id, energy: { gte: cost } },
    data:  { energy: { decrement: cost } },
  });
  if (deducted.count === 0) return res.status(400).json({ error: 'Not enough energy' });

  // Compute rewards — no current-stat reads needed here, all values are incremental.
  let goldGain = Math.floor(Math.random() * 41) + 20;

  // Ranger: +50% gold
  if (characterClass === 'RANGER') goldGain = Math.floor(goldGain * 1.5);

  // Warlord (WARRIOR_3): +20% gold
  if (characterClass === 'WARRIOR' && await hasSkill(req.user.id, 'WARRIOR_3')) {
    goldGain = Math.floor(goldGain * 1.2);
  }

  // Shadowblade: 30% chance to strike lucky and double gold
  let luckyStrike = false;
  if (characterClass === 'SHADOWBLADE' && Math.random() < 0.3) {
    goldGain   *= 2;
    luckyStrike = true;
  }

  // Bard: 20% charm bonus — extra 10–25 gold
  let charmBonus = 0;
  if (characterClass === 'BARD' && Math.random() < 0.2) {
    charmBonus = Math.floor(Math.random() * 16) + 10;
    goldGain  += charmBonus;
  }

  // Silver Tongue (BARD_1): +10% XP
  let xpGain = 10;
  if (characterClass === 'BARD' && await hasSkill(req.user.id, 'BARD_1')) {
    xpGain = Math.floor(xpGain * 1.1);
  }

  // Increment rewards — safe to run even if another write landed between the two updates.
  await prisma.stats.update({
    where: { userId: req.user.id },
    data:  { gold: { increment: goldGain }, xp: { increment: xpGain } },
  });

  const levelResult = await checkLevelUp(req.user.id);
  res.json({ goldGain, luckyStrike, charmBonus, xpGain, ...levelResult });
});

app.post('/api/action/train', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { characterClass } = req.user;
  const cost = await energyCost(20, characterClass, req.user.id);

  // Atomic energy deduct — rejects if energy is insufficient.
  const deducted = await prisma.stats.updateMany({
    where: { userId: req.user.id, energy: { gte: cost } },
    data:  { energy: { decrement: cost } },
  });
  if (deducted.count === 0) return res.status(400).json({ error: 'Not enough energy' });

  let strGain = Math.floor(Math.random() * 3) + 1;
  let defGain = 0;
  let intGain = 0;

  // Warrior: also gains defense
  if (characterClass === 'WARRIOR') defGain = Math.floor(Math.random() * 2) + 1;

  // Magician / Necromancer: train intelligence instead of strength
  if (characterClass === 'MAGICIAN' || characterClass === 'NECROMANCER') {
    intGain = strGain;
    strGain = 0;
  }

  // Cleric: trains INT and DEF, no raw strength
  if (characterClass === 'CLERIC') {
    intGain = Math.floor(Math.random() * 2) + 1;
    defGain = Math.floor(Math.random() * 2) + 1;
    strGain = 0;
  }

  // Bard: trains DEX and INT
  let dexGain = 0;
  if (characterClass === 'BARD') {
    dexGain = Math.floor(Math.random() * 2) + 1;
    intGain = Math.floor(Math.random() * 2) + 1;
    strGain = 0;
  }

  // Silver Tongue (BARD_1): +10% XP
  let xpGain = 15;
  if (characterClass === 'BARD' && await hasSkill(req.user.id, 'BARD_1')) {
    xpGain = Math.floor(xpGain * 1.1);
  }

  // All stat gains are incremental — safe regardless of concurrent writes.
  await prisma.stats.update({
    where: { userId: req.user.id },
    data: {
      strength:     { increment: strGain },
      defense:      { increment: defGain },
      intelligence: { increment: intGain },
      dexterity:    { increment: dexGain },
      xp:           { increment: xpGain },
    },
  });

  const levelResult = await checkLevelUp(req.user.id);
  res.json({ strGain, defGain, intGain, dexGain, xpGain, ...levelResult });
});

app.post('/api/action/rest', async (req, res) => {
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
        gold:   { decrement: goldCost },
        health: restoredHealth,
      },
    });

    if (deducted.count === 0) {
      return res.status(400).json({ error: 'Not enough gold to rest' });
    }

    res.json({ ok: true, discounted: goldCost === 15, goldCost });
  } catch (e) {
    console.error('/api/action/rest error:', e);
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
app.post('/api/skills/unlock', async (req, res) => {
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

    res.json({ ok: true, skill: skill.name, statPointsRemaining: updatedStats.statPoints });
  } catch (e) {
    if (e.code === 'NOT_ENOUGH_POINTS') return res.status(400).json({ error: 'Not enough stat points' });
    if (e.code === 'P2002')             return res.status(409).json({ error: 'Skill already unlocked' });
    console.error(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/action/skill — fire an active skill
app.post('/api/action/skill', async (req, res) => {
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
  return { leveledUp: true, newLevel, statPoints: stats.statPoints + 3 };
}

// ─── API: spend stat points ───────────────────────────────────────────────────

app.post('/api/spend-stat', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { stat } = req.body;
  const allowed = ['strength', 'defense', 'speed', 'dexterity', 'intelligence'];
  if (!allowed.includes(stat)) return res.status(400).json({ error: 'Invalid stat' });

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

app.post('/api/house/create', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { name, motto } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'House name must be at least 2 characters' });
  const existing = await prisma.houseMember.findUnique({ where: { userId: req.user.id } });
  if (existing) return res.status(400).json({ error: 'You already belong to a house' });
  try {
    const house = await prisma.$transaction(async (tx) => {
      // Atomically deduct 500 gold — rolls back house creation if insufficient.
      const deducted = await tx.stats.updateMany({
        where: { userId: req.user.id, gold: { gte: 500 } },
        data:  { gold: { decrement: 500 } },
      });
      if (deducted.count === 0) throw Object.assign(new Error('Not enough gold'), { code: 'NO_GOLD' });

      return tx.house.create({
        data: {
          name:    name.trim(),
          motto:   motto?.trim() || 'Strength through unity.',
          leaderId: req.user.id,
          members: { create: { userId: req.user.id, rank: 'Lord' } },
        },
      });
    });
    res.json({ ok: true, house });
  } catch (e) {
    if (e.code === 'NO_GOLD') return res.status(400).json({ error: 'Founding a house costs 500 gold' });
    if (e.code === 'P2002')   return res.status(409).json({ error: 'That house name is already taken' });
    console.error(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/house/join', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { houseId } = req.body;
  const existing = await prisma.houseMember.findUnique({ where: { userId: req.user.id } });
  if (existing) return res.status(400).json({ error: 'You already belong to a house' });
  const house = await prisma.house.findUnique({ where: { id: houseId } });
  if (!house) return res.status(404).json({ error: 'House not found' });
  await prisma.houseMember.create({ data: { userId: req.user.id, houseId, rank: 'Bannerman' } });
  res.json({ ok: true });
});

app.post('/api/house/leave', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const member = await prisma.houseMember.findUnique({ where: { userId: req.user.id } });
  if (!member) return res.status(400).json({ error: 'You are not in a house' });
  const house = await prisma.house.findUnique({ where: { id: member.houseId } });
  if (house.leaderId === req.user.id) return res.status(400).json({ error: 'Lords cannot abandon their house. Disband it instead.' });
  await prisma.houseMember.delete({ where: { userId: req.user.id } });
  res.json({ ok: true });
});

// ─── MARKET ───────────────────────────────────────────────────────────────────
app.get('/api/market/listings', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const listings = await prisma.listing.findMany({
    include: {
      item: true,
      seller: { select: { characterName: true } }
    },
    orderBy: { createdAt: 'desc' }
  });
  res.json(listings);
});

app.get('/api/market/inventory', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const inventory = await prisma.inventory.findMany({
    where: { userId: req.user.id },
    include: { item: true }
  });
  res.json(inventory);
});

app.post('/api/market/buy', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { listingId } = req.body;

  try {
    const listing = await prisma.$transaction(async (tx) => {
      // Fetch and immediately delete the listing inside the transaction.
      // This is the serialization lock: the second concurrent buyer's DELETE
      // will throw P2025 (record not found), rolling back their transaction
      // before any gold or inventory changes are made.
      const found = await tx.listing.findUnique({ where: { id: listingId }, include: { item: true } });
      if (!found) throw Object.assign(new Error('Listing not found'), { code: 'NOT_FOUND' });
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
    console.error(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/market/list', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { inventoryId, price, quantity } = req.body;
  if (!price || price < 1) return res.status(400).json({ error: 'Price must be at least 1 gold' });
  const inv = await prisma.inventory.findFirst({ where: { id: inventoryId, userId: req.user.id } });
  if (!inv) return res.status(404).json({ error: 'Item not found in your inventory' });
  if (inv.quantity < quantity) return res.status(400).json({ error: 'Not enough of that item' });
  await prisma.listing.create({ data: { sellerId: req.user.id, itemId: inv.itemId, price, quantity } });
  if (inv.quantity - quantity <= 0) {
    await prisma.inventory.delete({ where: { id: inv.id } });
  } else {
    await prisma.inventory.update({ where: { id: inv.id }, data: { quantity: inv.quantity - quantity } });
  }
  res.json({ ok: true });
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

app.post('/api/training/train', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { stat } = req.body;
  const cfg = TRAINING_CONFIG[stat];
  if (!cfg) return res.status(400).json({ error: 'Invalid stat' });

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

  if (stats.energy >= stats.maxEnergy) return; // already full, nothing to do

  const now       = new Date();
  const lastAt    = stats.lastEnergyAt ?? now;
  const elapsed   = now - lastAt;
  const intervals = Math.floor(elapsed / ENERGY_REGEN_INTERVAL_MS);

  if (intervals === 0) return; // not enough time has passed yet

  const gained    = intervals * ENERGY_REGEN_AMOUNT;
  const newEnergy = Math.min(stats.energy + gained, stats.maxEnergy);
  // Advance lastEnergyAt by exactly the intervals consumed — preserves leftover time.
  const newLastAt = new Date(lastAt.getTime() + intervals * ENERGY_REGEN_INTERVAL_MS);

  await prisma.stats.update({
    where: { userId },
    data:  { energy: newEnergy, lastEnergyAt: newLastAt },
  });
}

async function checkStatus(userId) {
  // Apply any pending energy regen ticks first.
  await regenEnergy(userId);

  const stats = await prisma.stats.findUnique({ where: { userId } });
  const now = new Date();
  const updates = {};
  if (stats.inJail && stats.jailUntil && now > stats.jailUntil) {
    updates.inJail = false;
    updates.jailUntil = null;
  }
  if (stats.inHospital && stats.hospitalUntil && now > stats.hospitalUntil) {
    updates.inHospital = false;
    updates.hospitalUntil = null;
    updates.health = stats.maxHealth;
  }
  if (Object.keys(updates).length > 0) {
    return await prisma.stats.update({ where: { userId }, data: updates });
  }
  return stats;
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
    console.error('/api/raid/status error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/raid/npc', async (req, res) => {
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
    res.json({ ...result, location: location.name, ...levelUp });

  } catch (e) {
    if (e && e.code === 'JAILED')    return res.status(400).json({ error: 'You are in jail' });
    if (e && e.code === 'HOSPITAL')  return res.status(400).json({ error: 'You are in hospital' });
    if (e && e.code === 'NO_ENERGY') return res.status(400).json({ error: 'Not enough energy' });
    console.error('/api/raid/npc error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/raid/player', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { targetId } = req.body;
  if (targetId === req.user.id) return res.status(400).json({ error: 'You cannot attack yourself' });

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

    res.json({
      ...result,
      targetName: target.characterName,
      ...levelUp
    });

  } catch (e) {
    if (e && e.code === 'JAILED')    return res.status(400).json({ error: 'You are in jail' });
    if (e && e.code === 'HOSPITAL')  return res.status(400).json({ error: 'You are in hospital' });
    if (e && e.code === 'NO_ENERGY') return res.status(400).json({ error: 'Not enough energy — attacks cost 20 energy' });
    console.error('/api/raid/player error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});






// ─── MONSTERS ─────────────────────────────────────────────────────────────────

const MONSTER_ZONES = [
  {
    id: 'woods',
    name: 'Cursed Woods',
    desc: 'A shadowed forest on the edge of the realm. Wolves and goblins prowl the treeline.',
    levelMin: 1,
    levelMax: 10,
    energyCost: 15,
    monsters: [
      { name: 'Feral Wolf', hpBase: 35, atkBase: 5, defBase: 1 },
      { name: 'Bog Goblin', hpBase: 45, atkBase: 6, defBase: 2 },
    ],
  },
  {
    id: 'marsh',
    name: 'Blighted Marsh',
    desc: 'Sickly waters hide things that used to be human. The air itself feels hostile.',
    levelMin: 8,
    levelMax: 20,
    energyCost: 22,
    monsters: [
      { name: 'Marsh Wretch', hpBase: 70, atkBase: 9, defBase: 4 },
      { name: 'Bloated Leech', hpBase: 90, atkBase: 7, defBase: 6 },
    ],
  },
  {
    id: 'ruins',
    name: 'Frostpeak Ruins',
    desc: 'The frozen remains of a fallen kingdom. Something still guards its halls.',
    levelMin: 18,
    levelMax: 35,
    energyCost: 30,
    monsters: [
      { name: 'Frost Wraith', hpBase: 140, atkBase: 14, defBase: 8 },
      { name: 'Ruin Golem', hpBase: 180, atkBase: 12, defBase: 12 },
    ],
  },
  {
    id: 'rift',
    name: 'The Abyssal Rift',
    desc: 'A tear in the world where nightmares crawl through. Only the strongest lords return.',
    levelMin: 30,
    levelMax: 50,
    energyCost: 40,
    monsters: [
      { name: 'Rift Stalker', hpBase: 240, atkBase: 20, defBase: 14 },
      { name: 'Voidbound Horror', hpBase: 300, atkBase: 18, defBase: 18 },
    ],
  },
];

// Threshold below which a losing fighter is considered defeated (mirrors raid hospital logic).
const COMBAT_DEFEAT_HEALTH = 10;

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

app.get('/api/monsters/zones', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  res.json({ zones: MONSTER_ZONES.map(z => ({
    id: z.id, name: z.name, desc: z.desc,
    levelMin: z.levelMin, levelMax: z.levelMax, energyCost: z.energyCost,
  })) });
});

app.get('/api/monsters/session', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const session = await prisma.combatSession.findUnique({ where: { userId: req.user.id } });
  res.json({ session });
});

app.post('/api/monsters/start', async (req, res) => {
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
      if (stats.energy < zone.energyCost) throw { code: 'NO_ENERGY' };

      await tx.stats.update({
        where: { userId: req.user.id },
        data: { energy: { decrement: zone.energyCost } },
      });

      const template = zone.monsters[Math.floor(Math.random() * zone.monsters.length)];
      const level = zone.levelMin + Math.floor(Math.random() * (zone.levelMax - zone.levelMin + 1));
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
    if (e && e.code === 'HOSPITAL')  return res.status(400).json({ error: 'You are in hospital' });
    if (e && e.code === 'NO_ENERGY') return res.status(400).json({ error: 'Not enough energy' });
    console.error('/api/monsters/start error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/monsters/turn', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { action } = req.body;
  if (!['attack', 'defend', 'flee'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

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
        await tx.combatSession.delete({ where: { userId: req.user.id } });

        return { won: true, log, goldReward, xpReward, monsterName: session.monsterName };
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
      return res.json({ ...result, ...levelUp });
    }
    res.json(result);

  } catch (e) {
    if (e && e.code === 'NO_SESSION') return res.status(400).json({ error: 'No fight in progress' });
    console.error('/api/monsters/turn error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Clans vs Society is running on port ${PORT}`);
});