# Phase 15 Design — Adversary/Environment Entity Model

Status: **DESIGN LOCKED** (data-model decisions resolved with Gregg; two
open items flagged below need confirmation before implementation). This is
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
- **OI2 — feature-type schema scope (open, hold for implementation).** D5 makes `hasFeatureType` a general
  schema capability rather than Adversary/Environment-only. Confirm no
  objection before touching the shared feature-editor UI in codex.js
  (search for existing `features` render/edit code first — this is a
  shared-code change, not additive-only in practice, since the editor
  needs a type selector added).

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
    { key: 'type', standalone: true, searchable: true }  // Exploration/Social/Traversal/Event
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
// Ported from encounter-builder's mapAdversaryFromSRD/mapFeatureFromSRD.
function normalizeAdversaryRecord(raw) {
  return {
    name: raw.name,
    description: raw.description || '',
    motives_and_tactics: raw.motives_and_tactics || '',
    experience: raw.experience || '',           // single string, not array — matches source shape directly (D4 target is prose, no need for encounter-builder's array-wrap trick)
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

// "Spit Acid - Action" -> {name: "Spit Acid", text: ..., type: "Action"}
function normalizeFeatureRecord(feature) {
  const parts = String(feature.name || '').split(' - ');
  const type = parts.length > 1 ? parts.pop().trim() : 'Passive';
  return { name: parts.join(' - ').trim() || feature.name || 'Feature', text: feature.text || '', type: type };
}

function normalizeEnvironmentRecord(raw) {
  return {
    name: raw.name,
    description: raw.description || '',
    type: raw.type || 'Exploration',
    feature: (raw.feature || []).map(normalizeFeatureRecord)
  };
}
```

`processType` calls the appropriate normalizer for `adversaries`/
`environments` type keys before `buildTemplateData(rec, schema)`; all
other SRD_TYPES entries pass `rec` through unchanged (no regression risk
to existing 11 types).

### 4.6 buildTemplateData — flavor line handling (D4)
No schema change needed — `motives_and_tactics`/`experience` are absent
from `detailKeys`, so they fall through `buildTemplateData`'s existing
`usedKeys`-gated leftover logic. Confirm during implementation that they
land in `flavorLines` (alongside `description`) rather than
`detailsLeftoverMd` — may need an explicit small addition to
`buildTemplateData`'s flavor-line collection step if it doesn't already
treat arbitrary non-whitelisted scalar keys as flavor by default (check
current behavior: existing flavor-line logic may only special-case
`description`/`note` by name, in which case `motives_and_tactics`/
`experience` need to be added to that specific list, not left to fall
through generically).

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
