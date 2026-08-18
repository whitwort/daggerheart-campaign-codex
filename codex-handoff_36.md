# Codex Handoff 36: Phase 15 kickoff — Adversary/Environment entity design

**Session**: Phase 15 exploration (integration with sibling repo
`whitwort/daggerheart-encounter-builder`). Design-only session, no code —
per Design-before-implementation convention, scoped and wrote the design
doc, no implementation started.
**HEAD**: `9ad1969` (design doc only, two commits this session).

---

## What happened this session

1. **Explored integration options**, spectrum from link-only to full
   reimplementation (not written up as a doc — decided in chat). Gregg's
   call: full reimplementation (Option 4) is the right long-term target —
   iOS-first workflow makes Apps Script/Sheets UI painful, and codex
   already has the hosting/auth/DB/visibility plumbing that made Sheets a
   workaround in the first place. Difficulty calculator and data models
   from encounter-builder are worth preserving via close-to-verbatim
   port; Sheet-layout generation and Drive-JSON storage are NOT — those
   get replaced by native Firestore entities + live tracking.
2. **Assessed port feasibility** by reading `DaggerheartCombatSystem.js`
   (5,153 lines, single-file Apps Script). Findings: the difficulty/
   battle-point calculator (`getDifficultyLevel`, `updateBattlePoints`) is
   pure client-side JS with no Apps Script API dependencies — near-verbatim
   portable. Data mapping functions (`mapAdversaryFromSRD`,
   `mapEnvironmentFromSRD`, `mapFeatureFromSRD`) are also near-verbatim
   portable. `DriveApp`/`PropertiesService`/`SpreadsheetApp` calls (storage,
   sheet-layout generation) have no 1:1 Firestore equivalent — genuine
   rewrite, not translation.
3. **Wrote and locked `phase-15-design.md`** — data model for representing
   Adversary/Environment as native entities using the existing template-
   schema/lore-item pattern (same mechanism as Weapons/Armor/Abilities).
   Committed `b4d16f3`, pushed.
4. **Resolved OI1** (attack_range standalone search indexing → `true`,
   matches weapons' `range` precedent). Committed `9ad1969`, pushed.
5. **OI2 held open** (feature `type` field touches shared feature display/
   edit code in codex.js, used by 6 existing template types — needs the
   actual render/edit functions located and scoped before deciding
   anything further). Explicit Gregg instruction: hold for implementation
   session, don't resolve now.

## Design doc summary (`phase-15-design.md`)

- New categories `Adversary`, `Environment`, no subtype, not added to
  `metaCategories`.
- Template schemas defined for both (detail keys, `hasFeatures: true`,
  new `hasFeatureType: true` capability for the Action/Passive/Reaction
  feature subfield — general schema capability, not adversary-specific).
- `motives_and_tactics`/`experience` deliberately NOT structured
  `details` — long-tail prose into the flavor lore item.
- No separate "custom adversary" mechanism — the existing template-driven
  entry editor IS the custom-adversary editor once these schemas exist.
  This fully replaces encounter-builder's bespoke custom-adversary/
  environment editor dialogs.
- SRD import: two new `SRD_TYPES` entries + a normalizer function (ported
  from `mapAdversaryFromSRD`/`mapFeatureFromSRD`) for the source's
  string-encoded fields (`"+3"` atk, `"8/15"` thresholds, `"Name - Type"`
  features), reusing `runSrdImport`/`processType`/`buildTemplateData`
  verbatim otherwise.
- Explicitly out of scope: difficulty calculator, the Encounter concept
  (session's adversary instances + live HP/Stress tracking), Sheet-layout
  generator. Separate design doc, next.
- §7 has a numbered implementation checklist for whoever picks this up.

## Open items carried forward

- **OI2** (feature-type UI scope) — held per Gregg, resolve at start of
  implementation session: locate codex.js's shared feature render/edit
  code path, confirm single code path serving all 6 existing template
  types, scope the `type` selector addition before writing any code.
- Encounter-workflow design doc (difficulty calc port, battle points,
  live HP/Stress tracking, what an "Encounter" actually is as an entity/
  feature) — not started, next Phase 15 design session.
- Standing deferred items, unchanged, no status change this session:
  player self-release clause, player-facing JSON export, Phase 16 (prod
  persistence rollout) pending go/no-go.

## Session ritual reminder

Fresh clone, verify HEAD `9ad1969`, git identity, read `QOL-BACKLOG.md` +
`phase-15-design.md` in full before starting implementation. Resolve OI2
first thing. No code has been written against this design yet — first
implementation session starts clean against the checklist in §7.
