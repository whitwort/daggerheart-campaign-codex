# Phase 15 Design — Encounter Workflow

Status: **DESIGN LOCKED** (signed off session 38; OI1 ack'd, OI2 yes-collapsed, OI3 as proposed, OI4 updatedAt desc).
**Amended (session 38, post-implementation review — A1):** the
single-view premise (§1 "build-time and play-time collapse into one
view") is replaced by a two-tab detail pane, Build / Run, after Gregg
flagged that adversary features had no display surface at all. §5.2 is
restructured below; the encounter doc model, calculator, and picker are
unchanged.
**Amended (session 38 — A2):** per-instance `note` (free text) is
replaced by `conditions: [string]` (0–3 condition names). The note
field was a stand-in for condition tracking Gregg always intended as
real UI; Run rows render one compact select per applied condition plus
one empty "add" select while under the cap of 3. Options come from
`category === 'Game Mechanics' && subtype === 'conditions'` entities
(the character deck's source), falling back to the three SRD core
conditions (Hidden, Restrained, Vulnerable) if none exist. Names are
stored, not entity ids — play-state is ephemeral and names display
directly. Existing stored `note` values are simply no longer rendered
(dev-only data). Second design doc under Phase 15
(`daggerheart-encounter-builder` integration). Prerequisite landed:
Adversary/Environment entity model (`phase-15-design.md`, sessions
36–37). Scope of this doc: the encounter-builder workflow itself —
building encounters from codex Adversary/Environment entities, the
battle-point difficulty calculator, and live HP/Stress tracking during
play. This supersedes encounter-builder's search dialog, calculator,
and Sheet-layout encounter generator; nothing of the Apps Script
storage/UI survives, only its math and interaction design.

## 1. Context

Encounter-builder's flow: a two-panel dialog (left: search/filter +
results; right: party config + battle-point readout + selected list),
then a "Build Encounter" step that renders a static formatted Sheet.
The Sheet output existed because Sheets was the only durable surface
available; in codex the encounter is a live document, so build-time and
play-time collapse into one view — the tracker *is* the artifact, and
the calculator stays live throughout. There is no "generate" step.

Decisions confirmed in chat (session 38 scoping):
- New GM-only top-level tab, not an Admin section (play-time surface,
  parallel to Characters).
- Dedicated resistance and difficulty-range filters from
  encounter-builder are dropped; text search stands in (see OI1 for
  the code-verified gap and its fix).
- GM-only throughout for v1. Future (out of scope): an AAR-style lore
  item attached to scenes concluded by a combat encounter.

## 2. Locked decisions

| # | Decision |
|---|---|
| E1 | New top-level tab **Encounters**, GM-only, hidden for players exactly like Admin (`style="display:none"` + shown by the same GM gate). Standard list-pane / detail-pane layout matching Codex and Characters. |
| E2 | New Firestore collection `encounters`, GM-only: `allow read, write: if isGM();`. No player surface, so this does not touch the deferred player-write rules matrix (§7 gate unaffected). |
| E3 | Doc shape: `{ name, createdAt, updatedAt, partySize, partyTier, highDamage, environmentId, instances }` where `instances: [{ entityId, fallbackName, label, hp, stress, note }]`. `hp`/`stress` are marked counts (ints). Per-instance from the start — the builder's +/− count controls create/remove instance rows. |
| E4 | Stats are read **live** from the `entities` snapshot cache (hp, stress, type, tier, difficulty, thresholds, attack_*), never denormalized into the encounter doc. Only mutable play-state is stored. `fallbackName` (snapshotted at add time) covers later entity deletion. |
| E5 | Calculator ported as pure functions into new `public/js/encounters.js` with **hardcoded** constants — no settings UI (encounter-builder had one; YAGNI here). Constants in §4. |
| E6 | Defeated state is **derived** (`hp marks ≥ hp max`), not stored. Fled/captured/etc. go in the per-instance `note`. |
| E7 | Adversary picker is a floating panel (gallery-picker precedent): search box + Tier/Type selects + results list with per-row Add. Search uses a picker-local matcher (OI1), not bare `entityMatchesQuery`. |
| E8 | Instance labels are stable: "Name N" assigned as the next unused index within that entity's group at add time; removing an instance never renumbers survivors (mid-combat identity must not shift). |

## 3. Data model detail

```
encounters/{encId}
  name: string
  createdAt, updatedAt: Timestamp
  partySize: int        (default 4)
  partyTier: int        (1–4, default 2)
  highDamage: bool      (default false)
  environmentId: string|null   // entities/ doc ID, category Environment
  instances: [
    { entityId: string,        // entities/ doc ID, category Adversary
      fallbackName: string,    // entity name at add time
      label: string,           // "Acid Burrower 2" — stable, E8
      hp: int,                 // marked HP count, clamped to live max on render
      stress: int,             // marked Stress count, same clamping
      conditions: [string] }   // 0–3 condition names (A2; replaced `note`)
  ]
```

- Writes go through the existing `trackWrite` pattern (pins precedent);
  every interaction persists immediately (updateDoc on the one doc —
  instances array replaced wholesale, same as features arrays on
  entities).
- Listener: `onSnapshot(collection(db,'encounters'), safeSnapshotHandler(...))`
  attached/detached with the GM listeners in the established
  sign-out-detach pattern (listeners die permanently on
  permission-denied otherwise).
- Missing entity (deleted after add): row renders `fallbackName`, gets
  a visible "entry missing" flag, battle value falls back to 2 (same
  fallback the source used for unknown types), hp/stress tracks render
  with unknown max (boxes for marks already made, no cap). Absent =
  degraded display, never a crash or a filtered-away row.
- Clamping: if an adversary entity's hp/stress details are edited down
  below existing marks, render clamps display; stored marks are only
  rewritten when the GM next interacts with that track.

## 4. Calculator port

Source: `getDifficultyLevel` / `updateBattlePoints` in
`DaggerheartCombatSystem.js` (confirmed pure-JS portable, handoff 35).
Ported verbatim in behavior; DOM/caching stripped.

Constants (module-level in encounters.js):

```
BATTLE_VALUES = { Minion:0, Standard:2, Horde:2, Skulk:2, Ranged:2,
                  Support:1, Social:1, Leader:3, Bruiser:4, Solo:5 }
UNKNOWN_TYPE_VALUE = 2
BASE_MULTIPLIER = 3       BASE_ADDITION = 2
MULTIPLE_SOLOS_ADJUSTMENT = -2   MIN_SOLOS_FOR_ADJUSTMENT = 2
LOWER_TIER_BONUS = 1      NO_ELITES_BONUS = 1
HIGH_DAMAGE_PENALTY = -2
ELITE_TYPES = ['Bruiser','Horde','Leader','Solo']
```

Point total:
- Minions: `ceil(count / partySize)` points per entity group (count =
  that entity's instance count).
- Everything else: `BATTLE_VALUES[type] ?? 2` per instance.
- `type` comes from `details.type` (free string, A3). Source data uses
  `Horde (N/HP)` variants — match on the **first word** of the type
  string (`type.trim().split(/[\s(]/)[0]`) so `Horde (2/HP)` maps to
  Horde. Encounter-builder got this for free because its mapper had
  already truncated; ours must not silently score all Hordes as 2.
  Same first-word match feeds the elite check.

Target and thresholds:
- base = `3 × partySize + 2`; adjustments: ≥2 Solo instances −2; any
  instance with `parseInt(details.tier) < partyTier` +1; no elite
  types present +1; high damage −2.
- Easy `< base−1`, Normal `≤ base`, Hard `≤ base+2`, Deadly above.

Displayed as: total points, per-group breakdown lines (`3× Skeleton
Warrior (6 pts)` / minion group form), difficulty chip (Easy/Normal/
Hard/Deadly, colored), and the full calculation breakdown (base,
adjustments, threshold ranges) in a collapsible section (collapsed by
default — OI2).

Recompute is pure client-side on every render pass from
(encounter doc × entities cache); no cached state (the source's
stateKey memoization existed for its VDOM, not needed here).

## 5. UI

### 5.1 Tab shell
- `nav#tabs` gains `<button id="tab-btn-encounters" data-tab="encounters-panel" style="display:none">Encounters</button>`, shown by the same GM check that reveals Admin. Placed between Characters and Admin.
- Panel: left list pane (encounter names + updated date, `+ New encounter` button — `#codex-new-btn` single-button exception family), right detail pane.

### 5.2 Detail pane — Build / Run tabs (amendment A1)

Two flat tabs inside the detail pane, reusing the Characters tab's
Cards/Sheet shell pattern (`.character-detail-tabs` — QOL exception 2).
Tab state lives in `state.encountersDetailTab`, shared and persistent
across selection changes (charactersDetailTab precedent). This is the
codex-native analogue of encounter-builder's build dialog vs. generated
run Sheet — same live doc underneath, two lenses on it.

**Build tab** (compose and budget the encounter):
1. **Header row**: encounter name (inline-editable), Delete (confirm).
2. **Party config row**: Players (number 1–8), Tier (select 1–4), High
   Damage (toggle-switch), Environment (select over
   category=Environment entities by name, "None" first).
3. **Difficulty panel**: total points, difficulty chip, per-group
   breakdown, collapsible full math (§4).
4. **Adversaries section**: grouped by entity — group header only
   (`N× {name}` linking to the codex entry, one-line stat summary,
   +/− controls: `+` adds an instance, `−` removes the
   highest-labeled *undamaged* instance if any, else the
   highest-labeled one). No per-instance rows here — instances are a
   Run concern. `+ Add adversary` opens the picker (§5.3).

**Run tab** (streamlined for the table):
1. Per adversary group: full stat block (the same
   `resolveEntityStatBlockMarkdown` render the environment uses —
   details AND features, closing the gap that triggered A1), then one
   row per instance: label, HP track boxes, Stress track boxes, note
   (inline text input), derived defeated styling (row dimmed +
   strikethrough label at full HP). The +/− controls appear here too
   (mid-combat reinforcements/removals are real), but the picker stays
   on Build.
2. **Environment block**: read-only stat block with entry link, after
   the adversary groups (mirrors the generated Sheet's ordering).
No name editing, config, or difficulty math on Run.

Track boxes reuse `.character-sheet-track-box` styling (plain/marked;
no third suggested state here). iOS-proven from Sheet tab.

**Future (recorded, unscoped — Gregg session 38):** Run tab will gain
start-of-combat and end-of-combat actions that trigger visibility
changes on a connected scene entity (and relates to the AAR lore item
in §7). Nothing modeled yet; the Build/Run divide is the prerequisite
being laid down now.

### 5.3 Adversary picker (floating panel)
- Search input + Tier select + Type select (both populated from live
  adversary data; type options use the first-word normalization so
  the Horde variants collapse to one option) + result list
  (name, tier/type/difficulty summary line, Add button per row —
  gallery-picker-body button exception family).
- Matcher (OI1): `entityMatchesQuery(entity, q)` OR case-insensitive
  substring over feature `text` OR substring over
  `details.difficulty`. Comma-AND semantics preserved by applying the
  extension per-term inside the same loop shape.
- Category filter: `Adversary` only, GM view (all entities visible).
- Adding N copies: tap Add repeatedly; the panel stays open.

## 6. Rules

```
match /encounters/{encId} {
  allow read, write: if isGM();
}
```

Deploy with the normal CI flow; no rules-matrix implications (E2).

## 7. Out of scope (recorded for later docs)

- Player-visible encounter/initiative screen.
- AAR-style lore item generated onto a scene entity when an encounter
  concludes (Gregg, session 38 — wants this eventually).
- Encounter archiving/status field — a doc is just editable anytime;
  delete when done, or keep as a template and duplicate (duplicate
  action itself is also deferred unless trivially cheap in review).
- Any settings UI for battle values/thresholds (E5).

## 8. Open items

- **OI1 — RESOLVED (ack'd).** Session-38
  chat assumed resistance/difficulty are "preserved in text well
  enough," but `computeSearchIndex` indexes searchable details and
  feature **names** only — feature body text (where resistances live)
  and `difficulty` (searchable:false) are invisible to
  `entityMatchesQuery`. Fix per E7: picker-local matcher extends the
  shared one with feature-text and difficulty substring matching,
  in-memory over ~129 adversaries. Global codex search is left
  untouched (flipping searchable flags would require re-import and
  pollute the shared index). Sign-off = ack that global codex search
  will still not find "resistant".
- **OI2 — RESOLVED.** Collapsed by default; the chip +
  total is the at-a-glance answer, math on demand.
- **OI3 — RESOLVED** as proposed (§5.2: prefer undamaged,
  else highest label). Alternative: per-instance × button only, no
  group −. Group − preserved as proposed because build-time count
  adjustment ("make it 4 skeletons") is the common case.
- **OI4 — RESOLVED.** updatedAt desc.
