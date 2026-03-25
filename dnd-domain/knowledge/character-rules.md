# D&D 5e Character Rules

Core rules for character creation, progression, and attributes relevant to dnd-ui.

## Ability Scores

Six core ability scores: STR, DEX, CON, INT, WIS, CHA.
- Range: 1–20 for typical characters. Maximum 30 with certain magic items/effects.
- Modifier = Math.floor((score - 10) / 2)
- At character creation, scores are typically assigned via standard array [15,14,13,12,10,8] or point buy.
- Racial bonuses increase ability scores.
- ASI (Ability Score Improvement) at levels 4, 8, 12, 16, 19: +2 to one score or +1 to two scores (max 20).

## Character Level

- Range: 1–20
- Each level grants: HP increase, class features, potentially new spell slots or spell levels.
- Proficiency Bonus by level:
  - Levels 1-4: +2
  - Levels 5-8: +3
  - Levels 9-12: +4
  - Levels 13-16: +5
  - Levels 17-20: +6

## Hit Points

- At 1st level: max Hit Die value + CON modifier
- Per level beyond 1st: roll Hit Die (or use average) + CON modifier (minimum 1)
- Maximum HP: sum of all HP gained per level
- Current HP: 0 to maximum HP
- Temporary HP: Separate pool, does not stack (take highest), lost first before regular HP
- At 0 HP: unconscious and making death saving throws (for player characters)
- Negative HP: D&D 5e does not use negative HP; 0 HP triggers death saves

## Armor Class

- Base AC with no armor: 10 + DEX modifier
- Light armor: armor's AC + DEX modifier
- Medium armor: armor's AC + DEX modifier (max +2)
- Heavy armor: armor's AC (DEX not added)
- Shield: +2 to AC

## Saving Throws

- Six saving throws, one per ability score
- Classes grant proficiency in two saving throws
- Roll: 1d20 + ability modifier + proficiency bonus (if proficient)
- Must meet or beat the effect's DC

## Skills

Each ability score has associated skills:
- STR: Athletics
- DEX: Acrobatics, Sleight of Hand, Stealth
- CON: (no associated skills)
- INT: Arcana, History, Investigation, Nature, Religion
- WIS: Animal Handling, Insight, Medicine, Perception, Survival
- CHA: Deception, Intimidation, Performance, Persuasion

Skill check: 1d20 + ability modifier + proficiency bonus (if proficient) + expertise bonus (if expertise: double proficiency)

## Races (Common)

Each race provides:
- Ability score increases (typically +1 to two scores, or +2/+1)
- Speed (base movement speed in feet)
- Special traits (darkvision, resistances, etc.)
- Languages

## Classes

Each class provides:
- Hit Die (d6 through d12)
- Primary ability scores
- Proficiencies (armor, weapons, tools, saving throws, skills)
- Class features at each level
- Spellcasting (if applicable): spell slots, spells known/prepared, spellcasting ability

### Spellcasting Classes
- Full casters (Bard, Cleric, Druid, Sorcerer, Wizard): 9 spell levels, use all slot levels
- Half casters (Paladin, Ranger): progress at half rate, max 5th level spells
- Third casters (Eldritch Knight, Arcane Trickster): max 4th level spells
- Warlock: Pact Magic — few slots, short rest recovery, all at highest slot level

## Multiclassing

- Can multiclass by meeting minimum ability score requirements
- Total level = sum of all class levels (max 20)
- Proficiency bonus uses total character level
- Spell slots use multiclassing spell slot table (combine caster levels)

## Resting

### Short Rest
- Minimum 1 hour
- Can spend Hit Dice: roll Hit Die + CON modifier to regain HP (can spend multiple)
- Hit Dice spent are expended until long rest

### Long Rest
- Minimum 8 hours (6 hours sleep for elves)
- Regain all HP
- Regain half of total Hit Dice (rounded up)
- Regain all spell slots (except Warlock)
- Regain most class features

## Experience Points and Leveling

- Characters gain XP from defeating monsters and completing milestones
- XP thresholds per level defined in the Player's Handbook
- Milestone leveling: GM grants level-ups at story beats (no XP tracking)

## Death and Dying

- At 0 HP: fall unconscious, begin death saving throws
- Death save: d20 roll each turn, no modifiers
  - 10+: success (3 successes = stable)
  - 9-: failure (3 failures = death)
  - Natural 1: counts as 2 failures
  - Natural 20: regain 1 HP immediately
- Stable: 0 HP but no longer making death saves; regain 1 HP after 1d4 hours
- Instant death: Taking damage equal to or greater than your HP maximum in a single hit
