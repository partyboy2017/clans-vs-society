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
    icon: '/assets/items/consumables/potion-minor-healing.png',
  },
  {
    name: 'Healing Potion',
    description: 'A proper healer\'s draught, favored by soldiers of the realm.',
    type: 'consumable',
    effect: 'health:75',
    basePrice: 35,
    icon: '/assets/items/consumables/potion-healing.png',
  },
  {
    name: 'Energy Draught',
    description: 'A bitter tonic that steadies the nerves and restores vigor.',
    type: 'consumable',
    effect: 'energy:40',
    basePrice: 20,
    icon: '/assets/items/consumables/draught-energy.png',
  },
  {
    name: 'Elixir of Vigor',
    description: 'A rare alchemical blend that restores both body and stamina.',
    type: 'consumable',
    effect: 'health:50,energy:50',
    basePrice: 60,
    icon: '/assets/items/consumables/elixir-vigor.png',
  },
  {
    name: 'Scroll of Wisdom',
    description: 'Ancient script said to sharpen the mind of whoever reads it aloud.',
    type: 'consumable',
    effect: 'xp:25',
    basePrice: 40,
    icon: '/assets/items/consumables/scroll-wisdom.png',
  },
  {
    name: 'Wolf Pelt',
    description: 'A coarse hide, still smelling faintly of the forest. Sells for a modest sum.',
    type: 'material',
    effect: '',
    basePrice: 8,
    icon: '/assets/items/materials/pelt-wolf.png',
  },
  {
    name: 'Goblin Tooth',
    description: 'A yellowed fang, sometimes traded as a grim trophy.',
    type: 'material',
    effect: '',
    basePrice: 5,
    icon: '/assets/items/materials/tooth-goblin.png',
  },
  {
    name: 'Ancient Coin',
    description: 'A coin from a kingdom long since fallen. Collectors pay well for these.',
    type: 'material',
    effect: '',
    basePrice: 25,
    icon: '/assets/items/materials/coin-ancient.png',
  },
];

async function main() {
  let created = 0;
  let updated = 0;

  for (const item of STARTER_ITEMS) {
    const existing = await prisma.item.findFirst({ where: { name: item.name } });
    if (existing) {
      if (existing.icon !== item.icon) {
        await prisma.item.update({ where: { id: existing.id }, data: { icon: item.icon } });
        updated++;
      }
      continue;
    }
    await prisma.item.create({ data: item });
    created++;
  }

  console.log(`Seed complete: ${created} item(s) created, ${updated} existing item(s) had their icon path updated.`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
