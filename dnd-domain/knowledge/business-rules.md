# dnd-ui Business Rules

Application-specific rules for the dnd-ui D&D 5e companion app.

## User Roles

Three roles with different capabilities:

### DM (Dungeon Master)
- Full access to all features
- Can create, edit, and delete campaigns, encounters, and monsters
- Can view all player character sheets
- Can trigger narrative events (session start/end, level up, death)
- Can set encounter difficulty and manage initiative
- Can override game rules (house rules)

### Player
- Access to their own character sheets only
- Can update HP, spell slots, conditions, and inventory during sessions
- Cannot view other players' characters unless DM grants permission
- Can view campaign notes shared by DM
- Cannot modify DM encounter data

### Spectator
- Read-only access
- Can view shared campaign state (initiative order, combat tracker if shared)
- Cannot modify any game data

## Authentication

- Local auth (no Firebase)
- JWT-based session tokens
- Roles assigned at invite time
- DM account created first when setting up a campaign

## Character Sheets

- Each character belongs to one Player user
- DM has read access to all characters in their campaign
- Character data includes: ability scores, HP (current, max, temp), AC, speed, proficiency bonus, saving throws, skills, attacks, spell slots, spells, features, inventory
- Character level is calculated from class levels (supports multiclass)
- HP cannot exceed maximum HP
- Temporary HP does not stack — always take the higher value
- A character at 0 HP with 3 death save failures is dead (cannot be revived without magic or DM narrative)

## Combat Tracker

- The DM creates and manages encounters
- Initiative is rolled per creature (monsters can be batch-rolled with variance)
- Turn order is determined by initiative (ties by DEX, then manually)
- Players can see the combat tracker during combat (read view)
- Only DM can advance turns
- Conditions applied to creatures must be tracked per creature
- HP changes are logged (who did what damage)
- When HP = 0, character/monster status changes to "downed" (characters) or "dead" (monsters, by default)
- Legendary creatures have Legendary Actions that occur outside their turn

## Spell Manager

- Spell slots are tracked per long/short rest cycle
- Cantrips always show as available (no slot tracking needed)
- Expended spell slots are marked used; cannot cast if no slots remain at required level or higher
- Concentration indicator shows when a concentration spell is active
- Casting a second concentration spell ends the first automatically
- Ritual casting is available for ritual-tagged spells and eligible classes; takes 10 extra minutes; no slot consumed
- Warlock slots recover on short rest; all other casters on long rest

## Inventory

- Items are stored per character
- Currency (cp, sp, ep, gp, pp) stored as integers
- Carry weight is tracked (optional setting per campaign)
- Attunement slots: max 3 per character
- Magic items can be attuned or unattuned via character sheet
- Item sharing between characters requires DM facilitation (narrative, not automatic)

## Dice Rolls

- All game dice rolls are simulated: d4, d6, d8, d10, d12, d20, d100 (percentile)
- Advantage/disadvantage: roll 2d20, take higher/lower
- Results are logged in the session feed
- DM can enable/disable public dice rolls (secret rolls for DM)

## Session Management

- Campaign session is started by DM
- All players join the active session
- Session end triggers optional long rest for all characters
- Session notes are editable by DM; shared snippets visible to players

## Data Validation Rules

- Ability scores: min 1, max 30 (enforce max 20 at character creation without magic)
- HP: min 0 (enforce this; no negative HP in 5e), max = character's max HP
- Spell level: 0–9
- Character level: 1–20
- Proficiency bonus: auto-calculated from total character level, not editable manually
- Spell save DC: auto-calculated = 8 + proficiency + spellcasting modifier, display only
- Spell attack bonus: auto-calculated = proficiency + spellcasting modifier, display only
- Initiative: stored per encounter, recalculated each combat start
- Currency values: non-negative integers only

## House Rules Support

- DM can enable optional rules: Flanking, Diagonal movement, Inspiration tokens, Variant Encumbrance
- These are stored as campaign settings
- UI should display which optional rules are active in campaign settings page

## Accessibility and UX

- Conditions should display with color-coded badges
- HP bars show current/max with color gradient (green → yellow → red)
- Death save trackers show circles (empty, success, failure) per the 5e ruleset
- Spell slots display as pips (filled = available, empty = expended)
- Initiative tracker shows active turn highlighted; next turn previewed
