# D&D 5e Item and Inventory Rules

Rules for equipment, items, currency, and encumbrance relevant to the Inventory feature of dnd-ui.

## Currency

Five currency types, all interchangeable:
- **Copper Piece (cp)**: Base unit
- **Silver Piece (sp)**: 1 sp = 10 cp
- **Electrum Piece (ep)**: 1 ep = 50 cp = 5 sp (rarely used)
- **Gold Piece (gp)**: 1 gp = 100 cp = 10 sp
- **Platinum Piece (pp)**: 1 pp = 1000 cp = 100 gp

All currency types should be stored as integer values (no fractional coins).

## Item Weight and Encumbrance

- Currency: 50 coins = 1 pound regardless of type
- **Carrying capacity**: STR score × 15 pounds (total weight before encumbered)
- **Variant Encumbrance** (optional rule):
  - Up to STR × 5 lbs: No penalty
  - STR × 5 to STR × 10 lbs: Encumbered (-10 ft speed)
  - STR × 10 to STR × 15 lbs: Heavily encumbered (-20 ft speed, disadvantage on STR/DEX/CON checks/saves/attack rolls)

## Weapon Properties

- **Finesse**: Can use STR or DEX (must use same modifier for attack and damage)
- **Heavy**: Small or Tiny creatures have disadvantage on attack rolls
- **Light**: Can be used in off-hand for two-weapon fighting
- **Loading**: Can only fire once per action (crossbows)
- **Reach**: Adds 5 feet to melee reach
- **Thrown**: Can be thrown for a ranged attack (uses STR for melee weapons, DEX for daggers/darts)
- **Two-handed**: Requires two hands
- **Versatile**: Can be used with one or two hands (two-hand damage listed in parentheses)
- **Ammunition**: Expended on use; can recover half after combat

## Armor Types

### Light Armor
- Padded: AC 11 + DEX
- Leather: AC 11 + DEX
- Studded Leather: AC 12 + DEX

### Medium Armor
- Hide: AC 12 + DEX (max +2)
- Chain Shirt: AC 13 + DEX (max +2)
- Scale Mail: AC 14 + DEX (max +2), disadvantage on Stealth
- Breastplate: AC 14 + DEX (max +2)
- Half Plate: AC 15 + DEX (max +2), disadvantage on Stealth

### Heavy Armor
- Ring Mail: AC 14, disadvantage on Stealth
- Chain Mail: AC 16, STR 13 required, disadvantage on Stealth
- Splint: AC 17, STR 15 required, disadvantage on Stealth
- Plate: AC 18, STR 15 required, disadvantage on Stealth

### Shield
- Adds +2 to AC
- Must be proficient to use without penalty

## Attunement

- Some magic items require attunement to use their full benefits
- Attuning takes a short rest
- A character can only be attuned to 3 magic items at a time
- Unattuning takes a short rest or occurs on character death

## Magic Item Rarity

- Common
- Uncommon
- Rare
- Very Rare
- Legendary
- Artifact (unique, story items)

Rarity affects typical gold piece value and how readily available an item is.

## Consumable Items

- **Potions**: Drinking uses a bonus action (for self) or action (for another creature)
- **Scrolls**: Requires being able to cast spells (or DC 10 Arcana check for non-casters); single use
- **Ammunition**: Expended on use; 50% can be recovered after combat

## Item Quantity Tracking

- Stackable items (arrows, bolts, coins, potions of the same type): track as quantity
- Non-stackable items: each is a separate inventory entry
- Ammunition: track both equipped amount and storage

## Equipment Slots (Optional Tracking)

Characters can equip/wear:
- Head (helmet, hat, circlet)
- Eyes (goggles, glasses)
- Neck (amulet, necklace)
- Cloak (back slot)
- Body (armor, robes)
- Belt (pouches)
- Hands/Gloves
- Fingers: 2 rings
- Feet (boots)
- Main hand (weapon or shield)
- Off hand (weapon, shield, or focus)

Note: D&D 5e does not have a strict slot system — DM determines what can be worn simultaneously.

## Common Magic Items

- Bag of Holding: holds 500 lbs in a 2-cu-ft space (weighs 15 lbs)
- Sending Stones: communicate over any distance
- Cloak of Elvenkind: Stealth advantage; penalties to Perception against you
- Boots of Speed: Dash as bonus action; double speed for 10 minutes
- Ring of Spell Storing: stores up to 5 levels of spells for later use

## Identifying Items

- Casting Identify (ritual) reveals properties and attunement requirements
- Short rest attuning also reveals properties at DM discretion
- Some items are cursed; only Remove Curse ends attunement to a cursed item
