# D&D 5e Combat Rules

Core combat mechanics relevant to the Combat Tracker feature of dnd-ui.

## Combat Structure

Each combat round = approximately 6 seconds of in-game time.

### Turn Order
1. Roll Initiative: 1d20 + DEX modifier. Ties broken by higher DEX (or coin flip).
2. Combatants act in initiative order (highest to lowest).
3. After all combatants act, a new round begins.

### On Your Turn
Each turn you get:
- **Action**: The main action (Attack, Cast a Spell, Dash, Disengage, Dodge, Help, Hide, Ready, Search, Use an Object)
- **Bonus Action**: Only if a class feature, spell, or ability grants one
- **Movement**: Up to your speed in feet (can split around actions)
- **Free Interaction**: One object interaction (draw a weapon, open a door, etc.)

### Reactions
- Triggered by specific events (opportunity attack, Ready action, certain spells)
- Only one reaction per round, refreshes at start of your turn

## Attack Rolls

**Melee Attack Roll**: 1d20 + STR modifier + proficiency bonus (if proficient)
- Finesse weapons can use DEX instead of STR

**Ranged Attack Roll**: 1d20 + DEX modifier + proficiency bonus (if proficient)

**Spell Attack Roll**: 1d20 + spellcasting ability modifier + proficiency bonus

**Hit**: Attack roll total ≥ target's AC → roll damage dice
**Miss**: Attack roll total < target's AC → no damage
**Critical Hit**: Natural 20 → double damage dice (e.g., 2d6 instead of 1d6)
**Critical Miss**: Natural 1 → automatic miss (no special effect by default in 5e)

## Damage and Healing

- Damage reduces current HP
- Healing increases current HP (cannot exceed maximum HP)
- **Resistance**: Take half damage (round down) from that damage type
- **Immunity**: Take no damage from that damage type
- **Vulnerability**: Take double damage from that damage type
- **Temporary HP**: Buffer before real HP; taken first. Cannot be healed, does not stack (take highest amount)

## Conditions in Combat

- **Blinded**: Auto-fail sight checks; attacks have disadvantage; attackers have advantage
- **Charmed**: Cannot attack charmer; charmer has advantage on Charisma checks
- **Deafened**: Auto-fail hearing; no penalty to attacks/AC in 5e
- **Frightened**: Disadvantage on ability checks and attacks while source is in sight; cannot move toward source
- **Grappled**: Speed = 0; grapple ends if grappler is incapacitated or target is moved out of reach
- **Incapacitated**: Cannot take actions or reactions
- **Invisible**: Attacks against you have disadvantage; your attacks have advantage; still detectable by sound/smell
- **Paralyzed**: Incapacitated; auto-fail STR/DEX saves; attackers have advantage; hits are crits within 5 feet
- **Petrified**: Transformed to stone; incapacitated; resistant to all damage; immune to poison and disease
- **Poisoned**: Disadvantage on attack rolls and ability checks
- **Prone**: Must use half movement to stand; attacks have disadvantage; melee attacks have advantage; ranged attacks have disadvantage
- **Restrained**: Speed = 0; attack rolls have disadvantage; attackers have advantage; DEX saves have disadvantage
- **Stunned**: Incapacitated; auto-fail STR/DEX saves; attackers have advantage
- **Unconscious**: Incapacitated and unaware; drops to ground (prone); auto-fail STR/DEX saves; attackers have advantage; hits within 5 feet are crits

## Movement and Positioning

- Standard speed: 30 feet (most races)
- Difficult terrain: costs double movement
- Crawling (while prone): costs double movement
- Climbing/swimming: costs double movement (unless class feature)
- Jumping: Long jump = STR score in feet (run), STR/2 feet (stand); High jump = 3 + STR modifier (run)
- Flying: Requires wing speed or spell; dropping prone while flying causes fall damage

## Opportunity Attacks

- Triggered when a hostile creature leaves your melee reach without Disengage
- Uses your reaction
- One melee attack (does not include bonus actions)

## Cover

- Half cover (+2 AC and DEX saves): low wall, large furniture
- Three-quarters cover (+5 AC and DEX saves): narrow window, thick tree
- Full cover: cannot be targeted directly

## Two-Weapon Fighting

- After Attack action with light melee weapon, can attack with a different light melee weapon as bonus action
- Bonus attack does NOT add ability modifier to damage (unless negative modifier)
- Two-Weapon Fighting style removes this restriction

## Grappling and Shoving

- Uses one attack (replaces one attack in a multi-attack sequence)
- Grapple: STR (Athletics) check vs. target's STR (Athletics) or DEX (Acrobatics) → success = grappled condition
- Shove: STR (Athletics) check vs. target's STR (Athletics) or DEX (Acrobatics) → push 5 feet or knock prone

## Mounted Combat

- Must use half movement to mount/dismount
- Horse speed used for movement
- If mount is knocked prone, rider must succeed DC 10 DEX save or fall prone adjacent

## Surprise

- If one side is surprised at combat start, they cannot act during the first round

## Concentrating

- Taking damage: CON saving throw, DC = 10 or half damage (whichever is higher), maintain concentration on success
- Being incapacitated or dying breaks concentration
- Only one concentration spell at a time
