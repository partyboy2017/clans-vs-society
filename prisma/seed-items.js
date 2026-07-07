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
  {
    name: 'Rat Tail',
    description: 'A grim little trophy. Not worth much, but every coin counts.',
    type: 'material',
    effect: '',
    basePrice: 3,
    icon: '/assets/items/materials/rat-tail.png',
  },
  {
    name: 'Tattered Coin Pouch',
    description: 'Stripped from a fallen bandit. Still holds a few coins\' worth of value.',
    type: 'material',
    effect: '',
    basePrice: 12,
    icon: '/assets/items/materials/pouch-tattered.png',
  },
  {
    name: 'Wolf Fang',
    description: 'A sharp fang, sometimes strung into a necklace by hunters.',
    type: 'material',
    effect: '',
    basePrice: 6,
    icon: '/assets/items/materials/wolf-fang.png',
  },
  {
    name: 'Wolf Claw',
    description: 'A curved claw, still sharp enough to draw blood.',
    type: 'material',
    effect: '',
    basePrice: 7,
    icon: '/assets/items/materials/wolf-claw.png',
  },
  {
    name: 'Boar Hide',
    description: 'Thick, bristled hide from a forest boar. Tanners pay fairly for these.',
    type: 'material',
    effect: '',
    basePrice: 9,
    icon: '/assets/items/materials/boar-hide.png',
  },
  {
    name: 'Boar Tusk',
    description: 'A yellowed tusk, prized by some as a hunting trophy.',
    type: 'material',
    effect: '',
    basePrice: 8,
    icon: '/assets/items/materials/boar-tusk.png',
  },
  {
    name: 'Goblin Ear',
    description: 'A grisly trophy proving a goblin was dealt with.',
    type: 'material',
    effect: '',
    basePrice: 4,
    icon: '/assets/items/materials/goblin-ear.png',
  },
  {
    name: 'Rusty Dagger',
    description: 'A crude blade, dull with rust. Barely worth melting down.',
    type: 'material',
    effect: '',
    basePrice: 10,
    icon: '/assets/items/materials/dagger-rusty.png',
  },
  {
    name: 'Rat Fur',
    description: 'Matted fur, still carrying the stench of the swarm.',
    type: 'material',
    effect: '',
    basePrice: 2,
    icon: '/assets/items/materials/rat-fur.png',
  },
  {
    name: 'Moldy Cheese',
    description: 'Best not to think too hard about where this came from.',
    type: 'material',
    effect: '',
    basePrice: 1,
    icon: '/assets/items/materials/cheese-moldy.png',
  },
  {
    name: 'Worn Leather Strap',
    description: 'A scrap of leather harness, salvageable for crafting.',
    type: 'material',
    effect: '',
    basePrice: 5,
    icon: '/assets/items/materials/leather-strap.png',
  },
  {
    name: 'Bandit\'s Mask',
    description: 'A tattered cloth mask, once worn to conceal a highwayman\'s face.',
    type: 'material',
    effect: '',
    basePrice: 14,
    icon: '/assets/items/materials/mask-bandit.png',
  },
  {
    name: 'Stick',
    description: 'It\'s a stick. Somehow, it\'s worth something.',
    type: 'material',
    effect: '',
    basePrice: 1,
    icon: '/assets/items/materials/stick.png',
  },
  {
    name: 'Rock',
    description: 'A rock. Rocks are timeless.',
    type: 'material',
    effect: '',
    basePrice: 1,
    icon: '/assets/items/materials/rock.png',
  },
  {
    name: 'Frying Pan',
    description: 'Dented and blackened with soot. Surprisingly effective in a pinch.',
    type: 'material',
    effect: '',
    basePrice: 3,
    icon: '/assets/items/materials/frying-pan.png',
  },
  {
    name: 'Rotten Cloth',
    description: 'Damp, foul-smelling rags pulled from the marsh. Barely worth the trouble.',
    type: 'material',
    effect: '',
    basePrice: 4,
    icon: '/assets/items/materials/cloth-rotten.png',
  },
  {
    name: 'Wretch Claw',
    description: 'A blackened claw, curled and brittle from the swamp\'s poison.',
    type: 'material',
    effect: '',
    basePrice: 10,
    icon: '/assets/items/materials/claw-wretch.png',
  },
  {
    name: 'Leech Sac',
    description: 'A bloated, pulsing sac. Alchemists pay well for these, if you can stomach carrying one.',
    type: 'material',
    effect: '',
    basePrice: 6,
    icon: '/assets/items/materials/leech-sac.png',
  },
  {
    name: 'Slimy Residue',
    description: 'A jar\'s worth of marsh slime. Somebody, somewhere, wants this.',
    type: 'material',
    effect: '',
    basePrice: 3,
    icon: '/assets/items/materials/residue-slimy.png',
  },
  {
    name: 'Serpent Fang',
    description: 'A curved fang, still faintly venomous to the touch.',
    type: 'material',
    effect: '',
    basePrice: 14,
    icon: '/assets/items/materials/fang-serpent.png',
  },
  {
    name: 'Snake Skin',
    description: 'A shed skin, patterned and surprisingly durable. Leatherworkers prize it.',
    type: 'material',
    effect: '',
    basePrice: 11,
    icon: '/assets/items/materials/skin-snake.png',
  },
  {
    name: 'Troll Hide',
    description: 'Thick, rubbery hide that shrugged off more than one of your blows.',
    type: 'material',
    effect: '',
    basePrice: 18,
    icon: '/assets/items/materials/hide-troll.png',
  },
  {
    name: 'Troll Tooth',
    description: 'A massive, yellowed tooth. Makes for an intimidating necklace.',
    type: 'material',
    effect: '',
    basePrice: 16,
    icon: '/assets/items/materials/tooth-troll.png',
  },
  {
    name: 'Waterlogged Coin Pouch',
    description: 'Recovered from a body that had been in the water far too long.',
    type: 'material',
    effect: '',
    basePrice: 20,
    icon: '/assets/items/materials/pouch-waterlogged.png',
  },
  {
    name: 'Rusted Cutlass',
    description: 'A sailor\'s blade, long since claimed by rust and rot.',
    type: 'material',
    effect: '',
    basePrice: 15,
    icon: '/assets/items/materials/cutlass-rusted.png',
  },
  {
    name: 'Barnacle Cluster',
    description: 'Crusted shells pried from something that spent too long underwater.',
    type: 'material',
    effect: '',
    basePrice: 5,
    icon: '/assets/items/materials/barnacle-cluster.png',
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
