// prisma/seed-items.js
//
// Seeds the starter item catalog. Safe to run multiple times — it only
// inserts items whose name isn't already present, so re-running won't
// create duplicates.
//
// Run with:  railway run node prisma/seed-items.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STARTER_ITEMS = [
  {
    name: 'Minor Healing Potion',
    description: 'A weak but reliable brew. Mends light wounds.',
    type: 'consumable',
    effect: 'health:30',
    basePrice: 15,
  },
  {
    name: 'Healing Potion',
    description: 'A proper healer\'s draught, favored by soldiers of the realm.',
    type: 'consumable',
    effect: 'health:75',
    basePrice: 35,
  },
  {
    name: 'Energy Draught',
    description: 'A bitter tonic that steadies the nerves and restores vigor.',
    type: 'consumable',
    effect: 'energy:40',
    basePrice: 20,
  },
  {
    name: 'Elixir of Vigor',
    description: 'A rare alchemical blend that restores both body and stamina.',
    type: 'consumable',
    effect: 'health:50,energy:50',
    basePrice: 60,
  },
  {
    name: 'Scroll of Wisdom',
    description: 'Ancient script said to sharpen the mind of whoever reads it aloud.',
    type: 'consumable',
    effect: 'xp:25',
    basePrice: 40,
  },
  {
    name: 'Wolf Pelt',
    description: 'A coarse hide, still smelling faintly of the forest. Sells for a modest sum.',
    type: 'material',
    effect: '',
    basePrice: 8,
  },
  {
    name: 'Goblin Tooth',
    description: 'A yellowed fang, sometimes traded as a grim trophy.',
    type: 'material',
    effect: '',
    basePrice: 5,
  },
  {
    name: 'Ancient Coin',
    description: 'A coin from a kingdom long since fallen. Collectors pay well for these.',
    type: 'material',
    effect: '',
    basePrice: 25,
  },
];

async function main() {
  let created = 0;
  let skipped = 0;

  for (const item of STARTER_ITEMS) {
    const existing = await prisma.item.findFirst({ where: { name: item.name } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.item.create({ data: item });
    created++;
  }

  console.log(`Seed complete: ${created} item(s) created, ${skipped} already existed.`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
