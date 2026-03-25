# D&D 5e Spell Rules

Core spellcasting mechanics relevant to the Spell Manager feature of dnd-ui.

## Spell Levels

- Level 0: Cantrips (at-will, no slot required, scale by character level)
- Levels 1–9: Leveled spells (require spell slots)
- Spell slots are not the same as spell levels: you may cast a 1st-level spell using a 3rd-level slot (upcasting).

## Spell Slots

- Represent available magical energy per long rest (Warlocks: per short rest)
- Slots are divided by level (1st through 9th)
- Casting a spell costs one slot of at least the spell's level
- Full casters (Bard, Cleric, Druid, Sorcerer, Wizard): access up to 9th-level slots at max level
- Half casters (Paladin, Ranger): up to 5th-level slots at max class level
- Third casters (EK, AT): up to 4th-level slots at max class level
- Warlocks: pact magic slots, all at the same level (1st–5th depending on Warlock level), recover on short rest

## Multiclass Spell Slot Calculation

For multiclassing, total caster levels:
- Full caster levels count at face value
- Half caster levels count at half
- Third caster levels count at one-third
- Sum these levels and look up the multiclassing spell slot table
- Warlock slots are tracked separately

## Preparing vs. Knowing Spells

- **Prepared casters** (Cleric, Druid, Paladin, Wizard): Choose from full class spell list each long rest. Prepared count = spellcasting ability modifier + class level (minimum 1).
- **Known casters** (Bard, Ranger, Sorcerer, Warlock): Fixed list of spells known, changed only on level up.
- Wizards also have spellbooks; they can learn spells by finding them.

## Spellcasting Components

- **Verbal (V)**: Must be able to speak; silenced creatures cannot cast spells with verbal components
- **Somatic (S)**: Must have a free hand; does not require material components hand to be empty
- **Material (M)**: A specific material component; can use a spellcasting focus to substitute most material components. Components with a gold cost or consumed by the spell cannot be substituted.

## Spell Duration and Concentration

- **Instantaneous**: Effect happens immediately and is permanent (e.g., damage dealt)
- **Sustained**: Effect lasts without concentration for a fixed duration
- **Concentration**: Effect requires maintaining concentration (see concentration rules in combat)
  - Can only concentrate on one spell at a time
  - Broken by: damage (CON save), incapacitation, casting another concentration spell, death
  - Concentration check DC: max(10, half damage taken), CON saving throw

## Cantrips

- Cast at will, no spell slot expended
- Scale in power at character levels 5, 11, and 17 (not class level — total character level)
- Common cantrips: Fire Bolt, Eldritch Blast, Sacred Flame, Toll the Dead, Mage Hand, Minor Illusion

## Spell Ranges

- **Self**: Only affects the caster
- **Touch**: Must touch the target (melee spell attack or willing target)
- **Fixed distance**: e.g., 60 feet, 120 feet
- **Sight**: The caster must be able to see the target

## Saving Throw Spells

- Spell Save DC = 8 + proficiency bonus + spellcasting ability modifier
- Target rolls saving throw vs. DC
- Failure: full effect
- Success: typically half damage (damage spells) or no effect (utility spells)
- Specific spell descriptions indicate what happens on save

## Spell Attack Rolls

- Used when a spell requires an attack roll to hit
- Roll: 1d20 + spellcasting ability modifier + proficiency bonus
- Must meet or exceed target's AC
- Advantage/disadvantage applies as normal
- Critical hits: double damage dice

## Area of Effect

- **Cone**: Point of origin, widens outward. 15-ft or 30-ft cone common.
- **Cube**: Edge length specified. Point of origin at corner or center.
- **Cylinder**: Radius and height specified.
- **Line**: Width and length specified.
- **Sphere**: Radius around point of origin or a point in range.

## Upcasting

- Casting a spell with a higher-level slot than required
- Only spells with "At Higher Levels" entries benefit
- Common upcasting: Cure Wounds (heal more), Magic Missile (more missiles), Hold Person (more targets)

## Ritual Casting

- Spells with the Ritual tag can be cast without a spell slot
- Takes 10 extra minutes
- Classes vary: Wizards can ritual cast from spellbook; Clerics/Druids can ritual cast any prepared ritual spell; Bards/Warlocks must have the Ritual Caster feat or specific subclass.

## Spell School Tags

Each spell belongs to one of eight schools:
- **Abjuration**: Protective, blocking, banishing
- **Conjuration**: Summoning, teleportation, creation
- **Divination**: Information gathering, future-sensing
- **Enchantment**: Influencing minds and behavior
- **Evocation**: Energy and damage output
- **Illusion**: Deception, sensory manipulation
- **Necromancy**: Undead, life-drain, death magic
- **Transmutation**: Physical change, transformation

## Counterspell

- Reaction spell; interrupts another creature casting a spell within 60 feet
- For spells of 3rd level or lower: automatic success
- For 4th level or higher: Arcana check DC 10 + spell level, or use a slot of the same or higher level for auto success

## Common Spellcasting Conditions (UI considerations)

- A character casting a concentration spell should show the concentration indicator
- Expended spell slots cannot be selected for casting
- Cantrips are always available (no slot cost)
- A spell cannot be cast if all slots of the required level and above are expended
- Ritual casting shows +10 minutes to cast time and does not consume a slot
