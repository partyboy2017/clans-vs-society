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
    desc: 'Masters death itself. Can rest without spending gold.',
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

// Helper: find a skill definition by its key across all trees
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
  res.json({
    username:       req.user.characterName || req.user.username,
    googleName:     req.user.googleName,
    email:          req.user.email,
    avatar:         req.user.avatar,
    characterClass: req.user.characterClass,
    classLabel:     req.user.characterClass ? CLASSES[req.user.characterClass].label : null,
    lastLoginAt:    req.user.lastLoginAt,
    createdAt:      req.user.createdAt,
    stats:          req.user.stats,
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
  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });

  // Pathfinder (RANGER_3): patrol costs 5 less energy
  let baseCost = 10;
  if (characterClass === 'RANGER' && await hasSkill(req.user.id, 'RANGER_3')) {
    baseCost = Math.max(0, baseCost - 5);
  }
  const cost = await energyCost(baseCost, characterClass, req.user.id);

  if (stats.energy < cost) return res.status(400).json({ error: 'Not enough energy' });

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
    goldGain    *= 2;
    luckyStrike  = true;
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

  await prisma.stats.update({
    where: { userId: req.user.id },
    data:  { energy: stats.energy - cost, gold: stats.gold + goldGain, xp: stats.xp + xpGain },
  });

  const levelResult = await checkLevelUp(req.user.id);
  res.json({ goldGain, luckyStrike, charmBonus, xpGain, ...levelResult });
});

app.post('/api/action/train', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { characterClass } = req.user;
  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
  const cost  = await energyCost(20, characterClass, req.user.id);

  if (stats.energy < cost) return res.status(400).json({ error: 'Not enough energy' });

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

  await prisma.stats.update({
    where: { userId: req.user.id },
    data: {
      energy:       stats.energy - cost,
      strength:     stats.strength     + strGain,
      defense:      stats.defense      + defGain,
      intelligence: stats.intelligence + intGain,
      dexterity:    stats.dexterity    + dexGain,
      xp:           stats.xp           + xpGain,
    },
  });

  const levelResult = await checkLevelUp(req.user.id);
  res.json({ strGain, defGain, intGain, dexGain, xpGain, ...levelResult });
});

app.post('/api/action/rest', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { characterClass } = req.user;
  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });

  // Necromancer: rests free | Cleric: half cost
  let goldCost = 30;
  if (characterClass === 'NECROMANCER') goldCost = 0;
  if (characterClass === 'CLERIC')      goldCost = 15;

  if (stats.gold < goldCost) return res.status(400).json({ error: 'Not enough gold' });

  // Blessing (CLERIC_3): rest restores extra 20 HP
  let restoredHealth = stats.maxHealth;
  if (characterClass === 'CLERIC' && await hasSkill(req.user.id, 'CLERIC_3')) {
    restoredHealth = Math.min(stats.maxHealth + 20, stats.maxHealth); // capped at maxHealth
  }

  await prisma.stats.update({
    where: { userId: req.user.id },
    data: {
      gold:   stats.gold - goldCost,
      health: restoredHealth,
      energy: stats.maxEnergy,
    },
  });
  res.json({ ok: true, free: goldCost === 0, discounted: goldCost === 15, goldCost });
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

  // Deduct points and apply any passive onUnlock stat bonuses
  const statDelta = { statPoints: stats.statPoints - skill.cost };
  if (skill.onUnlock) {
    for (const [k, v] of Object.entries(skill.onUnlock)) {
      statDelta[k] = (stats[k] ?? 0) + v;
    }
  }

  await prisma.$transaction([
    prisma.stats.update({ where: { userId: req.user.id }, data: statDelta }),
    prisma.userSkill.create({ data: { userId: req.user.id, skillKey } }),
  ]);

  res.json({ ok: true, skill: skill.name, statPointsRemaining: statDelta.statPoints });
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

  switch (skillKey) {
    case 'WARRIOR_2': { // Shield Bash — 15 energy, 15 dmg placeholder
      if (stats.energy < 15) return res.status(400).json({ error: 'Not enough energy' });
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { energy: stats.energy - 15 },
      });
      return res.json({ ok: true, message: 'Shield Bash connects — 15 damage dealt!', energyCost: 15 });
    }

    case 'RANGER_2': { // Ambush — 18 energy, 25 dmg
      if (stats.energy < 18) return res.status(400).json({ error: 'Not enough energy' });
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { energy: stats.energy - 18 },
      });
      return res.json({ ok: true, message: 'You strike from the shadows — 25 damage!', energyCost: 18 });
    }

    case 'MAGICIAN_2': { // Fireball — 12 energy, 35 dmg
      if (stats.energy < 12) return res.status(400).json({ error: 'Not enough energy' });
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { energy: stats.energy - 12 },
      });
      return res.json({ ok: true, message: 'Fireball erupts — 35 damage!', energyCost: 12 });
    }

    case 'NECROMANCER_2': { // Soul Drain — 20 energy, heal 25 HP
      if (stats.energy < 20) return res.status(400).json({ error: 'Not enough energy' });
      const newHp     = Math.min(stats.health + 25, stats.maxHealth);
      const healAmount = newHp - stats.health;
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { energy: stats.energy - 20, health: newHp },
      });
      return res.json({ ok: true, message: `Soul Drain — you absorb ${healAmount} HP.`, energyCost: 20, healAmount });
    }

    case 'SHADOWBLADE_2': { // Backstab — 15 energy, bonus gold
      if (stats.energy < 15) return res.status(400).json({ error: 'Not enough energy' });
      const bonusGold = Math.floor(Math.random() * 30) + 20;
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { energy: stats.energy - 15, gold: stats.gold + bonusGold },
      });
      return res.json({ ok: true, message: `Backstab lands true — ${bonusGold} gold looted!`, energyCost: 15, goldGain: bonusGold });
    }

    case 'CLERIC_2': { // Holy Light — 20 energy, heal 40 HP
      if (stats.energy < 20) return res.status(400).json({ error: 'Not enough energy' });
      const newHp     = Math.min(stats.health + 40, stats.maxHealth);
      const healAmount = newHp - stats.health;
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { energy: stats.energy - 20, health: newHp },
      });
      return res.json({ ok: true, message: `Holy Light heals you for ${healAmount} HP.`, energyCost: 20, healAmount });
    }

    case 'BARD_2': { // Ballad of Greed — 10 energy, 25–50 gold
      if (stats.energy < 10) return res.status(400).json({ error: 'Not enough energy' });
      const charmGold = Math.floor(Math.random() * 26) + 25;
      await prisma.stats.update({
        where: { userId: req.user.id },
        data:  { energy: stats.energy - 10, gold: stats.gold + charmGold },
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
  const newLevel      = stats.level + 1;
  const newXp         = stats.xp - xpNeeded;
  const newMaxHealth  = stats.maxHealth + 20 + (perLevel.maxHealth || 0);
  const newMaxEnergy  = stats.maxEnergy + 10;

  await prisma.stats.update({
    where: { userId },
    data: {
      level:        newLevel,
      xp:           newXp,
      maxHealth:    newMaxHealth,
      health:       newMaxHealth,
      maxEnergy:    newMaxEnergy,
      energy:       newMaxEnergy,
      statPoints:   stats.statPoints + 3,
      strength:     stats.strength     + (perLevel.strength     || 0),
      defense:      stats.defense      + (perLevel.defense      || 0),
      speed:        stats.speed        + (perLevel.speed        || 0),
      dexterity:    stats.dexterity    + (perLevel.dexterity    || 0),
      intelligence: stats.intelligence + (perLevel.intelligence || 0),
    },
  });
  return { leveledUp: true, newLevel, statPoints: stats.statPoints + 3 };
}

// ─── API: spend stat points ───────────────────────────────────────────────────

app.post('/api/spend-stat', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { stat } = req.body;
  const allowed = ['strength', 'defense', 'speed', 'dexterity', 'intelligence'];
  if (!allowed.includes(stat)) return res.status(400).json({ error: 'Invalid stat' });

  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
  if (stats.statPoints < 1) return res.status(400).json({ error: 'No stat points available' });

  await prisma.stats.update({
    where: { userId: req.user.id },
    data:  { [stat]: stats[stat] + 1, statPoints: stats.statPoints - 1 },
  });
  res.json({ ok: true, stat, newValue: stats[stat] + 1 });
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
  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
  if (stats.gold < 500) return res.status(400).json({ error: 'Founding a house costs 500 gold' });
  try {
    const house = await prisma.house.create({
      data: {
        name: name.trim(),
        motto: motto?.trim() || 'Strength through unity.',
        leaderId: req.user.id,
        members: { create: { userId: req.user.id, rank: 'Lord' } }
      }
    });
    await prisma.stats.update({ where: { userId: req.user.id }, data: { gold: stats.gold - 500 } });
    res.json({ ok: true, house });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'That house name is already taken' });
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
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { item: true } });
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.sellerId === req.user.id) return res.status(400).json({ error: 'You cannot buy your own listing' });
  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
  if (stats.gold < listing.price) return res.status(400).json({ error: 'Not enough gold' });

  // Transfer gold
  await prisma.stats.update({ where: { userId: req.user.id }, data: { gold: stats.gold - listing.price } });
  await prisma.stats.update({ where: { userId: listing.sellerId }, data: { gold: { increment: listing.price } } });

  // Add item to buyer inventory
  const existing = await prisma.inventory.findFirst({ where: { userId: req.user.id, itemId: listing.itemId } });
  if (existing) {
    await prisma.inventory.update({ where: { id: existing.id }, data: { quantity: existing.quantity + listing.quantity } });
  } else {
    await prisma.inventory.create({ data: { userId: req.user.id, itemId: listing.itemId, quantity: listing.quantity } });
  }

  // Remove listing
  await prisma.listing.delete({ where: { id: listingId } });
  res.json({ ok: true, item: listing.item.name });
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

  const stats = await prisma.stats.findUnique({ where: { userId: req.user.id } });
  if (stats.energy < cfg.energyCost) return res.status(400).json({ error: 'Not enough energy' });

  const now = Date.now();
  const last = stats[cfg.cooldownField];
  const elapsed = last ? now - new Date(last).getTime() : TRAINING_COOLDOWN_MS + 1;
  if (elapsed < TRAINING_COOLDOWN_MS) {
    const remaining = Math.ceil((TRAINING_COOLDOWN_MS - elapsed) / 1000);
    return res.status(400).json({ error: `Still recovering — ${remaining}s remaining` });
  }

  const gain = Math.floor(Math.random() * 2) + 1;
  const updated = await prisma.stats.update({
    where: { userId: req.user.id },
    data: {
      energy: stats.energy - cfg.energyCost,
      [cfg.statField]: stats[cfg.statField] + gain,
      xp: stats.xp + cfg.xpGain,
      [cfg.cooldownField]: new Date()
    }
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
async function checkStatus(userId) {
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
  const stats = await checkStatus(req.user.id);
  const now = new Date();
  res.json({
    stats,
    locations: NPC_LOCATIONS,
    inJail: stats.inJail,
    jailRemainingMs: stats.inJail && stats.jailUntil ? Math.max(0, stats.jailUntil - now) : 0,
    inHospital: stats.inHospital,
    hospitalRemainingMs: stats.inHospital && stats.hospitalUntil ? Math.max(0, stats.hospitalUntil - now) : 0,
  });
});

app.post('/api/raid/npc', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { locationId } = req.body;
  const location = NPC_LOCATIONS.find(l => l.id === locationId);
  if (!location) return res.status(400).json({ error: 'Invalid location' });

  const stats = await checkStatus(req.user.id);
  if (stats.inJail) return res.status(400).json({ error: 'You are in jail' });
  if (stats.inHospital) return res.status(400).json({ error: 'You are in hospital' });
  if (stats.energy < location.energyCost) return res.status(400).json({ error: 'Not enough energy' });

  // Combat calculation
  const attackPower = stats.strength + stats.speed + Math.floor(Math.random() * 15);
  const defensePower = location.difficulty + Math.floor(Math.random() * 10);
  const won = attackPower >= defensePower;

  const goldGain = won ? Math.floor(Math.random() * (location.goldMax - location.goldMin + 1)) + location.goldMin : 0;
  const xpGain = won ? location.xpGain : Math.floor(location.xpGain * 0.2);

  const updateData = {
    energy: stats.energy - location.energyCost,
    xp: stats.xp + xpGain,
  };

  let jailMins = 0;
  let hospitalMins = 0;

  if (won) {
    updateData.gold = stats.gold + goldGain;
  } else {
    // Check if jailed or hospitalized
    const caught = Math.random() < location.jailChance;
    if (caught) {
      jailMins = location.jailMins;
      updateData.inJail = true;
      updateData.jailUntil = new Date(Date.now() + jailMins * 60 * 1000);
    } else {
      // Injured - hospital
      hospitalMins = Math.ceil(location.jailMins / 2);
      const newHealth = Math.max(1, stats.health - Math.floor(stats.maxHealth * 0.3));
      updateData.health = newHealth;
      if (newHealth <= 10) {
        updateData.inHospital = true;
        updateData.hospitalUntil = new Date(Date.now() + hospitalMins * 60 * 1000);
        updateData.health = 1;
      }
    }
  }

  await prisma.stats.update({ where: { userId: req.user.id }, data: updateData });
  const levelUp = won ? await checkLevelUp(req.user.id) : { leveledUp: false };

  res.json({
    won,
    goldGain,
    xpGain,
    jailMins,
    hospitalMins,
    location: location.name,
    ...levelUp
  });
});

app.post('/api/raid/player', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { targetId } = req.body;
  if (targetId === req.user.id) return res.status(400).json({ error: 'You cannot attack yourself' });

  const attackerStats = await checkStatus(req.user.id);
  if (attackerStats.inJail) return res.status(400).json({ error: 'You are in jail' });
  if (attackerStats.inHospital) return res.status(400).json({ error: 'You are in hospital' });
  if (attackerStats.energy < 20) return res.status(400).json({ error: 'Not enough energy — attacks cost 20 energy' });

  const target = await prisma.user.findUnique({ where: { id: targetId }, include: { stats: true } });
  if (!target || !target.stats) return res.status(404).json({ error: 'Target not found' });

  const defenderStats = await checkStatus(targetId);

  // Combat
  const attackPower  = attackerStats.strength + attackerStats.speed     + Math.floor(Math.random() * 20);
  const defensePower = defenderStats.defense   + defenderStats.dexterity + Math.floor(Math.random() * 20);
  const won = attackPower >= defensePower;

  const xpGain = won ? 30 : 10;
  const goldStolen = won ? Math.floor(defenderStats.gold * (Math.random() * 0.1 + 0.05)) : 0;

  const attackerUpdate = {
    energy: attackerStats.energy - 20,
    xp: attackerStats.xp + xpGain,
    gold: attackerStats.gold + goldStolen,
  };

  const defenderUpdate = {};
  let defenderJailed = false;
  let defenderHospitalized = false;

  if (won) {
    defenderUpdate.gold = defenderStats.gold - goldStolen;
    // Injure defender
    const newHealth = Math.max(1, defenderStats.health - Math.floor(defenderStats.maxHealth * 0.25));
    defenderUpdate.health = newHealth;
    if (newHealth <= 10) {
      defenderUpdate.inHospital = true;
      defenderUpdate.hospitalUntil = new Date(Date.now() + 10 * 60 * 1000);
      defenderUpdate.health = 1;
      defenderHospitalized = true;
    }
  } else {
    // Attacker loses and gets caught
    const newHealth = Math.max(1, attackerStats.health - Math.floor(attackerStats.maxHealth * 0.2));
    attackerUpdate.health = newHealth;
    if (newHealth <= 10) {
      attackerUpdate.inHospital = true;
      attackerUpdate.hospitalUntil = new Date(Date.now() + 8 * 60 * 1000);
      attackerUpdate.health = 1;
    }
  }

  await prisma.stats.update({ where: { userId: req.user.id }, data: attackerUpdate });
  if (Object.keys(defenderUpdate).length > 0) {
    await prisma.stats.update({ where: { userId: targetId }, data: defenderUpdate });
  }

  const levelUp = await checkLevelUp(req.user.id);

  res.json({
    won,
    goldStolen,
    xpGain,
    targetName: target.characterName,
    defenderHospitalized,
    ...levelUp
  });
});






const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Clans vs Society is running on port ${PORT}`);
});