# Codex handoff 27 — Phase 14 S7 complete (new feature injection + multi-image upload)

**HEAD after this session: `4e93297`** ("Phase 14 S7: new feature injection (§11) + multi-image gallery upload"). CI green, deployed to dev. Design-only groundwork landed first as `64a1da7`. Verify HEAD matches on clone before doing anything.

S7 wasn't in the original phase-14-design.md session plan — Gregg injected 8 new feature requests mid-phase (after S6, before the original integration-polish S7, which is now **S8**). Scoped in chat first (verified against live SRD JSON before finalizing what needed schema/rules work vs. what didn't), written up as `phase-14-design.md` §11, reviewed by Gregg, then implemented same session. A late 9th item (multi-image gallery upload) was added and folded in before commit.

## What landed (§11, all 8 original items + multi-image upload)

1. **Mixed ancestry (1-2 per character)** — `templates.js`'s `Ancestry/` schema gains `featureGroups: [first, second]` + a new `featureGroupsFromArray` flag (Ancestry's SRD source data is one flat `feature[]` of exactly 2, unlike subclasses' per-tier-keyed arrays — verified against all 18 current SRD ancestries). `srd-import.js`'s `buildTemplateData` maps that flat array positionally on reimport, no manual migration needed. `characters.js` gets `normalizeAncestryIds`/`resolveFunctionalAncestryIds`/`resolveFunctionalIds` + a full `buildAncestrySlotEditor` (1-2 slot add/remove, First/Second feature-group picks with mutual-exclusion auto-flip when 2 are selected).
2. **Meta ancestries** — new `metaAncestryTargetIds` field (0-2, Ancestry entities only; flavor entity's own name/lore displays, features resolve through the target(s) instead). Chaining explicitly disallowed (Gregg's call — "complicates design, easily circumvented with homebrew ancestry") via excluding already-meta ancestries from the picker. `codex.js` entity-edit form gets the "Functional ancestry" picker for Ancestry-category entities. `buildEntityDraft`/`saveEntityEdit` wired to round-trip it.
3. **Ad hoc character cards** — "+ New card for this character" button in the Characters tab, **GM-only** (caught before shipping: player-authored non-Character entity creation is rules-denied — `isValidEntity()`'s player create path is `category=='Character'` only). Reuses existing `visibility:'character'` infra as-is, zero schema/rules change. Abilities-only scope (Gregg's call), no cap/exemption logic needed since there's no existing max-abilities enforcement to work around.
4. **Lore item expand/collapse + pop-out edit** — height-triggered (post-render `scrollHeight` check, 320px threshold) collapse with fade + "Show more/less"; "Open in window" pops the full item into a draggable floating panel reusing `buildGalleryPickerPanel` (generic despite the gallery-specific name/class). Panel's own Edit button closes it and re-enters the *same* inline edit flow as the normal Edit button — factored into a shared `openLoreItemEdit(entity, item, isNote, entityAuthority)` so there's exactly one edit-entry code path, not two.
5. **Narrative Backstory meta tag** — `'meta-narrative-backstory'` added to the meta enum (`metaBadgeLabel`, `normalizeMetaForEdit`, edit dropdown, `firestore.rules`). Plain badge, no auto-synthesis behavior (that stays exclusive to `meta-details`/`meta-features`).
6. **Claiming filtered to PC-tagged characters** — one-line filter in `characters.js`'s "available characters" list, case-insensitive match on the existing free-text `tags` array. No schema/rules change — pure convention going forward (tag claimable PCs with "PC").
7. **Class-scoped subclass/ability filtering** — **zero schema/rules change**, confirmed by fetching live SRD JSON before scoping: `class.details.subclass_1`/`subclass_2` and `ability.details.domain` are already plain strings that exact-match Subclass/Domain entity names. Filter is a name-match in `buildCardSlotEditor` once `cards.classId` is set; empty until a class is chosen (Gregg's call, deferring picker UX polish to a later pass). Character-scoped ad hoc cards (item 3) bypass the domain filter.
8. **Badge color propagation** — share popup (`visibility-ui.js`): `partyCharacterOptions()` now carries `badgeColor`, rendered as a small dot (`.vis-kebab-char-dot`) before the name. Messages tray: GM-side per-player tabs get a top/bottom accent border colored by that player's **active character's** `badgeColor` (`activeCharacterBadgeColor()` in `messages.js`) — confirmed as the right tradeoff despite the color shifting if the player switches active character mid-session. Both new CSS rules are ordered before `.unread`/`.active` in source so those states still win when both apply (identity cue, not an alert).
9. **Multi-image gallery upload** (late addition, not in original §11 scope) — `openGalleryUploadModal` (`codex.js`) now supports `input.multiple`, sequential (not parallel — WebP encoding is CPU-heavy WASM, iPad-primary usage) per-file processing through the unchanged `uploadEntityGalleryImage`, continues past individual file failures and summarizes at the end. Button relabeled "+ New images"; QOL-BACKLOG exception 8 note updated to match.

## Bugfix caught in the process

`buildEntityDraft` (`codex.js`) was dropping `group` off `features` when building the edit draft from an existing entity — reopening any `featureGroups` entity (Subclass tiers; now also Ancestry) for edit would silently empty every tier/group's feature list, since the editor filters on `f.group === g.key` and a stripped `group` never matches. Pre-existing bug, not introduced this session, but the new Ancestry `featureGroups` usage would have hit it immediately — fixed alongside. Also confirmed `saveEntityEdit` round-trips `metaAncestryTargetIds` (Ancestry-only, normalized to `[]` for other categories, same pattern as `ancestry`/`ownerId`).

## Net schema/rules delta

Small, on purpose — most of §11 turned out to need zero schema/rules work once checked against real data:
- New fields: `metaAncestryTargetIds` (Ancestry entities), `cards.ancestryIds`, `cards.ancestryFeaturePicks` (Character `cards` sub-object — stays unvalidated, same as every other `cards` field).
- Rules: 2 one-line additions — `isValidEntity()` key whitelist gains `metaAncestryTargetIds`; `isValidLoreItem()`'s meta enum gains `'meta-narrative-backstory'`.
- Everything else is UI/filter logic against fields that already existed.

## Verification run

ESLint clean; `node --check` all files; CSS braces 538/538; rules braces 63/63; named-import cross-check clean (the S5 deploy-break class — every `import {x} from './y.js'` verified against the target's actual top-level names, ~25-line Python script, worth keeping in the standing gate per handoff 26).

## §7 rules test matrix — CLOSED

Six sessions overdue as of handoff 26 ("SIX SESSIONS OLD, NOW LOAD-BEARING FOR S6"). Gregg ran the 12-row allowed/denied matrix (from handoff 26's chat) against dev with a real GM + player session and reported no failures — full pass, nothing flagged. This was blocking S7/S8 per handoff 26; no longer blocking anything. The 2 new rules lines this session (`metaAncestryTargetIds`, `meta-narrative-backstory`) were small enough to hand-verify against the rules file directly rather than needing another live-session pass — same reasoning Gregg used in S5's handoff for its rules-untouched sessions.

## Not yet manually tested on dev (next session or Gregg directly)

1. Mixed ancestry picker + meta ancestry ("Goat"→Faun style) end to end, including the meta-can-be-mixed case (a single meta pick whose target list has 2 entries).
2. Ad hoc card button visibility (GM flipper: shows; player's own-character view: does NOT show).
3. Long lore item collapse/expand + pop-out window + its Edit shortcut, on iPad specifically (draggable panel drag behavior, keyboard/Escape close).
4. Multi-image gallery upload — a batch mixing large/small files, and one deliberately-bad file to confirm the rest of the batch still lands and the failure summary reads sensibly.
5. Claiming list — confirm existing unowned Characters without a "PC" tag correctly drop out of the "available to claim" list (this is a behavior change from before — previously any unowned+visible Character was claimable).
6. Class-scoped subclass/ability filtering against a real Class/Subclass pair from imported SRD data (not just the JSON verification done this session).
7. Badge-color dot in the share popup + Messages tray tab underline, visual check both light-on-parchment (popup) and dark-panel (tray) contexts.
8. `.action-btn-compact` width at "+ New images" (one char longer than the old "+ New image" it was sized against) — flagged as low-risk but unverified visually.

## Next

- S8 (renumbered from the original S7): integration polish, QOL sweep, full two-browser (GM+player) walkthrough of every Phase 14 feature S1-S7.
- Prod persistence rollout (Phase 13) still pending; Phase 15 = prod concerns.
- If more mid-phase feature injections come up before S8, same pattern as this session: scope in chat, verify against real data before committing to schema/rules changes, write up as a design-doc addendum, get explicit sign-off, then implement.

Session ritual unchanged: fresh clone, verify HEAD `4e93297`, git identity, read QOL-BACKLOG.md + phase-14-design.md (now including §11) + this doc.
