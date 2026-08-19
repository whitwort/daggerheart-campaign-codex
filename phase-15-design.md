# Phase 15 Design — Adversary/Environment Entity Model

Status: **DESIGN LOCKED, AMENDED** (all open items resolved; §3.1 records
source-verification amendments made at implementation start). This is
the first design doc under Phase 15 (`daggerheart-encounter-builder`
integration exploration, renumbered per handoff 35). Scope of this doc:
model Adversaries and Environments as native codex entities, reusing the
existing template/lore/SRD-import machinery. It does NOT cover the
encounter-builder workflow itself (search/filter dialog, battle-point
calculator, live HP/Stress tracking during play) — that's a follow-up
design doc, deferred until this foundation lands.

## 1. Context

`whitwort/daggerheart-encounter-builder` is a standalone Google Apps
Script bound to a Sheet: Drive-JSON-backed adversary/environment data,
SRD auto-sync from `seansbox/daggerheart-srd`, a battle-point difficulty
calculator, and a Sheet-layout encounter generator. Gregg's read: the
Sheets/Drive storage layer was always a hosting/auth/DB workaround —
those are solved problems in codex — but the UI/UX flow, the difficulty
math, and the data models took real design iteration and are worth
preserving, not redesigning from scratch.

Decision (prior session): model Adversaries and Environments as normal
codex entities, using the same category → template schema → structured
`details`/`features` → lore-item pattern already established for
Weapons/Armor/Abilities/Ancestry/Community/etc. This doc is that model.

## 2. Locked decisions

| # | Decision |
|---|---|
| D1 | New top-level categories `Adversary` and `Environment`, no subtype (mirrors Ancestry/Community — an adversary's "type" (Standard/Solo/Leader/...) is a `details` field, not a taxonomic subtype). |
| D2 | Neither category is added to `metaCategories` — adversaries/environments are world-present, same treatment as `Character`, so they remain eligible for map pins like any other entity (not forced off the map). |
| D3 | `thresholds` stored as the source string shape (`"8/15"`), not split into two fields — consistent with weapons' compound `damage` string; display formatting splits it, storage doesn't. |
| D4 | `motives_and_tactics` and `experience` are NOT structured `details` — they're long-tail GM-facing prose, folded into the flavor lore item alongside `description`. Nothing needs to filter/search on them precisely. |
| D5 | Feature shape gains an optional third field: `{name, text, type}[]` — `type` holds Action/Passive/Reaction. Additive change, not adversary-specific: existing weapon/armor/ability features simply have `type: undefined` and render unchanged. Modeled as a new schema capability `hasFeatureType: true`, not hardcoded to Adversary/Environment. |
| D6 | Custom adversaries/environments are NOT a separate mechanism. Creating an `Adversary`/`Environment` entity through the existing Codex entry editor with `useTemplate: true` **is** "custom adversary" — same structured detail/feature editor already built for the pilot template types. This replaces encounter-builder's bespoke custom-adversary/environment editor dialogs outright. |
| D7 | SRD import reuses `runSrdImport`/`processType`/`buildTemplateData` verbatim. Only new work: two `SRD_TYPES` entries + a pre-processing normalizer for the two source-specific string encodings (`"+3"` atk modifier, `"8/15"` thresholds, `"Name - Type"` feature strings) — ported near-verbatim from encounter-builder's `mapAdversaryFromSRD`/`mapEnvironmentFromSRD`/`mapFeatureFromSRD`. |

## 3. Open items

- **OI1 — RESOLVED.** `attack_range` is `standalone: true` (matches
  weapons' `range` precedent; categorical values, no collision risk
  identified).
- **OI2 — RESOLVED (implementation session, code audit).** Single shared
  code path confirmed: codex.js's feature edit UI is one function with a
  grouped branch (featureGroups schemas: Subclass, Ancestry) and a flat
  branch (everything else). Adversary/Environment hit the flat branch
  only, so all `hasFeatureType` changes are gated on the flag and touch:
  (a) flat edit branch — add a type field; (b) `buildFeaturesMarkdown`
  flat branch — render `**Name - Type:**` when `f.type` present;
  (c) the edit draft's feature mapping — add `type` passthrough;
  (d) `buildTemplateData`'s flat feature map — add `type` when present.
  Grouped branch, `computeSearchIndex`, and character-cards.js confirmed
  untouched. Additive-only in practice.

## 3.1 Amendments from source verification (implementation session)

Live fetch of `seansbox/daggerheart-srd` `adversaries.json` (129 records)
and `environments.json` (19 records) surfaced three discrepancies vs. the
original design (which inherited encounter-builder's mappers, themselves
lossy). All three resolved with Gregg, design amended in place below:

- **A1 — Environment source is richer than modeled.** Real records carry
  `tier`, `difficulty`, `impulses`, `potential_adversaries` — all dropped
  by encounter-builder's `mapEnvironmentFromSRD` and absent from the
  original schema here. Amended: `tier`/`difficulty` join Environment
  `detailKeys` (same flags as Adversary's); `impulses` and
  `potential_adversaries` fold into flavor prose (same D4 treatment as
  `motives_and_tactics`). Additionally, environment features carry an
  extra `question` field (GM prompt) that a bare `{name,text}` map would
  silently drop — the normalizer appends it to `text` as a trailing
  italic line.
- **A2 — Flavor routing fixed in the normalizer, not shared code.**
  §4.6's concern confirmed: `buildTemplateData`'s flavor collection
  special-cases only `description`/`note` by name; extra prose keys
  would land as meta-details leftover bullets. Resolution: the
  normalizer composes `description` itself as markdown (`description` +
  `**Motives & Tactics:** …` + `**Experience:** …` paragraphs) and
  omits the raw keys from its output. `buildTemplateData` stays
  untouched; §4.6's "may need an addition" is moot.
- **A3 — Feature type is not a closed enum.** Source suffix census:
  Action 198, Passive 180, Reaction 100, plus 17 compound values like
  `Reaction: Countdown (5)`. The edit UI's type field is therefore a
  free text input with a datalist (Action/Passive/Reaction) rather than
  a strict select. One malformed source name (`Take Off- Action`, no
  space before the hyphen) defeats a plain `' - '` split; the
  normalizer splits with `/^(.*\S)\s*-\s+(\S.*)$/` (greedy — splits at
  the last `"- "` occurrence; verified 0 features contain a second
  `" - "`, and hyphenated names like `Long-Term` have no trailing
  space so can't misparse).

D5's "Action/Passive/Reaction" and the schema comment's adversary type
list (source also has `Minion` and `Horde (N/HP)` variants) are
descriptive, not validated enums — all `details` values and feature
`type` are free strings.

## 4. Schema deltas

### 4.1 config.js
```js
categories: [..., 'Adversary', 'Environment'],   // append, order TBD (end of list, consistent with how Ancestry/Community/Game Mechanics/Equipment were appended in Phase 12b)
// metaCategories: unchanged — Adversary/Environment NOT added
```
No `subtypesByCategory` entries (D1).

### 4.2 templates.js — new TEMPLATE_SCHEMAS entries

```js
'Adversary/': {
  detailKeys: [
    { key: 'type',            standalone: true,  searchable: true },  // Standard/Solo/Leader/Bruiser/Horde/Skulk/Ranged/Support/Social
    { key: 'tier',             standalone: false, searchable: true },
    { key: 'difficulty',       standalone: false, searchable: false },
    { key: 'hp',                standalone: false, searchable: false },
    { key: 'stress',            standalone: false, searchable: false },
    { key: 'thresholds',        standalone: false, searchable: false },  // "8/15" string, see D3
    { key: 'attack_modifier',   standalone: false, searchable: false },
    { key: 'attack_name',       standalone: false, searchable: false },
    { key: 'attack_range',      standalone: true,  searchable: true },   // see OI1
    { key: 'attack_damage',     standalone: false, searchable: false }
  ],
  hasFeatures: true,
  hasFeatureType: true   // see D5
},
'Environment/': {
  detailKeys: [
    { key: 'type', standalone: true, searchable: true },  // Exploration/Social/Traversal/Event
    { key: 'tier',       standalone: false, searchable: true },   // A1
    { key: 'difficulty', standalone: false, searchable: false }   // A1
  ],
  hasFeatures: true,
  hasFeatureType: true
}
```

`motives_and_tactics`/`experience` (D4) are deliberately absent from
`detailKeys` — they flow into the flavor lore item via `buildTemplateData`'s
existing `flavorLines` mechanism (same bucket as `description`/`note`),
not through the schema whitelist.

### 4.3 templates.js — feature shape
`computeSearchIndex` unaffected (features already index by `name` only,
`type` doesn't need to be searchable). The `{name, text, type}` shape
change is confined to: `buildTemplateData`'s feature-mapping branches (add
`type` passthrough when present), and codex.js's feature display/edit
code (render `type` as a badge/label next to the feature name when
present; add a `type` selector to whatever UI currently edits
`features[]` items — locate and confirm scope before starting, per OI2).

### 4.4 srd-import.js — new SRD_TYPES entries
```js
{ key: 'adversaries', category: 'Adversary', subtype: null },
{ key: 'environments', category: 'Environment', subtype: null }
```

### 4.5 srd-import.js — source record normalizer (new)
`seansbox/daggerheart-srd`'s `adversaries.json`/`environments.json` use
source-specific string encodings not shared by any currently-imported
type. A normalizer runs BEFORE `buildTemplateData`, producing a `rec`
shape `buildTemplateData` can consume directly via the schema above:

```js
// Ported from encounter-builder's mapAdversaryFromSRD/mapFeatureFromSRD,
// amended per A1/A2/A3.
function normalizeAdversaryRecord(raw) {
  // A2: prose keys composed into description here, not passed through —
  // buildTemplateData only routes description/note to flavor.
  const flavor = [raw.description || ''];
  if (raw.motives_and_tactics) flavor.push('**Motives & Tactics:** ' + raw.motives_and_tactics);
  if (raw.experience) flavor.push('**Experience:** ' + raw.experience);
  return {
    name: raw.name,
    description: flavor.filter(Boolean).join('\n\n'),
    type: raw.type || 'Standard',
    tier: raw.tier,
    difficulty: raw.difficulty,
    hp: raw.hp,
    stress: raw.stress,
    thresholds: raw.thresholds || '0/0',          // pass through as-is (D3)
    attack_modifier: raw.atk,                      // "+3" string passthrough — display layer strips/formats, not import
    attack_name: raw.attack || 'Basic Attack',
    attack_range: raw.range || 'Melee',
    attack_damage: raw.damage || '',
    feature: (raw.feature || []).map(normalizeFeatureRecord)
  };
}

// "Spit Acid - Action" -> {name: "Spit Acid", text: ..., type: "Action"}.
// A3: greedy regex (splits at LAST "- "), not split(' - ') — survives the
// one malformed source name ("Take Off- Action"). A1: environment
// features' `question` prompt appended to text as a trailing italic line.
function normalizeFeatureRecord(feature) {
  const rawName = String(feature.name || '');
  const m = rawName.match(/^(.*\S)\s*-\s+(\S.*)$/);
  const name = m ? m[1] : rawName;
  const type = m ? m[2] : 'Passive';
  let text = feature.text || '';
  if (feature.question) text += (text ? '\n\n' : '') + '*' + feature.question + '*';
  return { name: name || 'Feature', text: text, type: type };
}

function normalizeEnvironmentRecord(raw) {
  // A1/A2: impulses + potential_adversaries fold into flavor prose.
  const flavor = [raw.description || ''];
  if (raw.impulses) flavor.push('**Impulses:** ' + raw.impulses);
  if (raw.potential_adversaries) flavor.push('**Potential Adversaries:** ' + raw.potential_adversaries);
  return {
    name: raw.name,
    description: flavor.filter(Boolean).join('\n\n'),
    type: raw.type || 'Exploration',
    tier: raw.tier,               // A1
    difficulty: raw.difficulty,   // A1
    feature: (raw.feature || []).map(normalizeFeatureRecord)
  };
}
```

`processType` calls the appropriate normalizer for `adversaries`/
`environments` type keys before `buildTemplateData(rec, schema)`; all
other SRD_TYPES entries pass `rec` through unchanged (no regression risk
to existing 11 types).

### 4.6 buildTemplateData — flavor line handling (D4)
RESOLVED via A2: confirmed `buildTemplateData` only special-cases
`description`/`note`, so the normalizer composes all prose into
`description` itself and omits the raw keys. `buildTemplateData`
unchanged.

## 5. Import idempotency / update semantics

Unchanged from existing SRD import (§ srd-import.js header comment):
matched by `(category, subtype, slug)`, existing entities updated in
place, `imported` lore items deleted-and-rewritten fresh on update. No
Adversary/Environment-specific deviation.

## 6. Explicitly out of scope for this doc

- Encounter-builder's difficulty/battle-point calculator (`getDifficultyLevel`,
  `updateBattlePoints`) — pure logic, ports near-verbatim, but belongs to
  the encounter-workflow design doc, not entity modeling.
- The "Encounter" concept itself (a session's selected adversary
  instances + live HP/Stress tracking) — separate entity or feature,
  next design doc.
- Sheet-layout generator (`buildEnhancedEncounterLayout` etc.) — no direct
  codex equivalent; superseded by whatever UI the encounter-workflow doc
  designs, not ported.
- Map pin behavior specifics for Adversary/Environment entities beyond
  "not excluded via metaCategories" (D2) — default map behavior applies,
  no new design needed unless play reveals a gap.

## 7. Implementation checklist (for the session that picks this up)

1. Confirm OI1/OI2 with Gregg.
2. `config.js`: add categories.
3. `templates.js`: add two schema entries; add `hasFeatureType` support to
   `computeSearchIndex` call sites if needed (verify none — search index
   doesn't touch `type`).
4. Locate + extend the shared feature display/edit code path in codex.js
   for the new `type` field (render + edit UI) — audit scope before
   starting, this is the one genuinely shared-code touch point.
5. `srd-import.js`: add SRD_TYPES entries + normalizer functions + wire
   normalizer call into `processType` (or `buildTemplateData` entry
   point — whichever keeps the change smallest) for the two new type keys
   only.
6. Manual test: run "Update entries" against dev, spot-check a handful of
   known adversaries/environments (e.g. compare against encounter-
   builder's existing Drive-cached data for the same names) for field
   parity.
7. Manual test: create one fully custom Adversary and one custom
   Environment via the normal entry editor, confirm useTemplate editor UX
   parity with existing pilot types (Weapons/Armor/Abilities).
8. Handoff doc, per standard session ritual.
