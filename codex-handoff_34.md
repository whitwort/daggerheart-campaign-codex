# Codex Handoff 34: Phase 14.S17 Character Sheet — Design Only (next: implementation)

**Session**: Character sheet feasibility exploration + design doc addendum. No code changes this session.
**HEAD**: `3493785`
**Status**: Design locked in `phase-14-design.md` §12, committed and pushed, CI green. No implementation started.

---

## Session Summary

Gregg's ask: expand the S15 character deck viewer with a character-sheet feature, tracking stats/resources between sessions.

**Viability discussion** (four options of increasing complexity, presented before any design work):
1. No feature — status quo.
2. Passive form — schema-backed fields, no computation.
3. Semi-automated suggestions — base values suggested from structured SRD data, editable/overridable.
4. Full dynamic engine (D&D Beyond-style) — live recompute from all selected cards, equip state, temp effects.

Checked `templates.js` before assessing: Class has structured `hp`/`evasion`, Armor has `base_score`/`base_thresholds`, Subclass has `spellcast_trait` — but every other mechanical modifier (subclass/ancestry/community features, most item bonuses) is freeform prose only, never tagged with machine-readable effects. This ruled out option 4 as a near-term target — no rules-engine authoring layer exists, and none of the SRD data supports one without separate large scoping work.

**Gregg picked option 2 + a "cheap route" version of 3** — passive tracking, plus lightweight suggestions from the three fields that ARE structured today.

**PDF parsing check**: fetched Darrington Press's official Daggerheart Character Sheets & Guides PDF (May 2025) via `web_fetch` (not `bash_tool` — `daggerheart.com` isn't in the bash egress allowlist; `web_fetch` has a separate, broader network path and worked fine). Confirmed the front-page field set is **identical across all 9 class sheets + the generic blank sheet** — one schema covers every class. Full field inventory, and what's chargen-flavor vs. tracked state vs. deferred (Beastform/Companion pages), is in the design doc §12 intro. Flagged the copyright caveat explicitly (Gregg beat me to it, unprompted) — field set/grouping informed the design, not Darrington Press's actual page layout/art.

**Two refinements from Gregg after the first design pass**:
- No bulk "Reset to suggested" button — instead a per-field **(i) icon** with two states: *Match* (current value == live suggestion) and *Updated* (live suggestion has changed since the field was last set). Required adding `cards.sheet.suggestedSnapshot` to make "changed since last set" actually derivable (comparing live suggestion against both the current value AND the snapshot at last-write time) — a value that diverges from the suggestion but hasn't moved since being set shows no icon at all (deliberate override, not staleness, don't nag).
- Character detail panel becomes a **two-tab layout**: "Cards" (today's `character-deck.js` render, unchanged) and "Sheet" (this feature). Frames it explicitly as mirroring the physical-table context switch between looking at your cards vs. your sheet.

## Design doc changes (`phase-14-design.md` §12, all committed)

- **12.1** — new `cards.sheet` schema: `traits` (6, each `{value, marked}`), `evasion`, `armorScore`, `proficiency`, `hp`/`stress`/`hope` (`{max, marked}`), `thresholds` (`{major, severe}`), `gold` (`{handfuls, bags, chest}`). Unvalidated `cards` sub-object, no `firestore.rules` change, same convention as `equipment`/`conditions`/`experiences`.
- **12.2** — `cards.equipment[i]` gains optional `slot: 'primary'|'secondary'|'armor'|null`. Extends the existing flat equipment array rather than adding a new one; UI enforces single-occupant per slot (not rules-enforced, matches the app's existing "UI nudges, rules don't" pattern e.g. `abilityIds`'s 2-ability minimum).
- **12.3** — suggested-value indicator mechanics: live-suggestion sources (Class `hp`/`evasion`, armor-slot item's `base_score`/`base_thresholds` + current level), `suggestedSnapshot` storage, the 3-way render logic (Match / Updated / no-icon), click-to-apply-single-field behavior.
- **12.4** — Cards/Sheet tab placement, reusing the existing flat-tab convention (QOL-BACKLOG exception 2), Equipment slot picker stays in Cards (not duplicated into Sheet).
- Explicitly out of scope, logged in the doc: live/dynamic recompute (option 4), tier-progression/background-question/description-prompt text (static reference, not tracked state), Druid Beastform / Ranger Companion supplemental tracking, parsing the PDF's per-class "Suggested Traits" prose into structured data.

## Verification / commit

Single doc-only commit (`3493785`), CSS/brace-balance check n/a (markdown), pushed, CI polled and green. No code touched.

## Next Session Plan

Implementation, per the 6-commit plan agreed at end of this session (all against `phase-14-design.md` §12, no further design decisions expected unless something surfaces during build):

1. **Cards/Sheet tab shell** (`characters.js`) — tab strip on both `#characters-detail-pane` (GM) and `#characters-player-selected` (player); move existing `character-deck.js` render under "Cards", empty "Sheet" placeholder tab. New tab-button selector → add to QOL-BACKLOG exception 2 list. **Riskiest commit** — touches the shared pane structure both GM and player views depend on; test both views live before moving to commit 2.
2. **Sheet: traits row** — 6 toggleable trait cards (value + marked) → `cards.sheet.traits` via `patchCards`.
3. **Sheet: resources block** — HP/Stress/Hope/Thresholds/Evasion/Armor Score/Proficiency fields, plain passive writes, no suggestion logic yet.
4. **Sheet: gold counter** — handfuls/bags/chest.
5. **Equipment slot model** — `cards.equipment[i].slot` + picker UI in the existing Equipment section (Cards tab), single-occupant enforcement for primary/secondary/armor.
6. **Suggested-value indicator** — live-suggestion helper + (i) icon Match/Updated states + `suggestedSnapshot` + click-to-apply. Depends on commit 3 (fields exist) and commit 5 (armor slot exists to read from).

Model recommendation: Sonnet is fine for all 6 — design primitives are fully locked, this is chunked UI implementation against a specified schema, not open design work.

Still-open, untouched this session (carried from handoff 33, unrelated to S17):
- Multi-image gallery upload edge cases.
- Player self-release rules clause (`ownerId → null`) — not yet live-tested.
- Prod persistence rollout (Phase 15) — still pending Gregg's explicit go/no-go.

Session ritual unchanged: fresh clone, verify HEAD `3493785`, git identity, read `QOL-BACKLOG.md` + `phase-14-design.md` (especially new §12) + this doc before starting.
