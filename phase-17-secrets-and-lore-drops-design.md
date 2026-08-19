# Phase 17 — Secrets discoverability + Lore Drops

Signed off in chat (Aug 19 2026). Two features. Phase 16 (prod rollout)
numbering unchanged; encounter-builder integration exploration resumes
after this.

## Part A — Secrets discoverability (player view)

### A1. "Secret" badge extension

Today the badge renders only when the entity ITSELF is in the
green/secret state for the viewer: `visibility=='character' &&
characterId==ctx.activeCharacterId && !characterShared`. Extend: badge
also renders when any CHILD lore element (loreItem or image) of the
entity is in that state for the viewer. Same badge, same style, both
cases. Works identically in GM preview-as-player (comes free via ctx).

Data sources:
- Entity itself + loreItems: already fully in state (`allEntities`,
  `allLoreItems`).
- Images: NOT globally loaded (docs carry inline base64). New
  persistent filtered listener `images where visibility=='character'`
  (`state.allCharacterImages`, `characterImagesUnsub`), attached
  alongside the entities/loreItems listeners for both roles (rules
  allow; expected doc count small). The `data` field is STRIPPED when
  stored in state — only metadata is kept (memory hygiene; the badge
  needs existence + ownerId + characterId + characterShared only).

New helper `entityHasSecretsFor(entity, ctx)` in visibility.js (it is
visibility semantics and visibility.js already imports state).

### A2. "Show secrets" mode

Button in `#codex-list-actions`, player view only (incl. preview),
rendered/gated dynamically by renderList: visible only when at least
one entity has secrets for the viewer. Clicking toggles
`state.secretsFilterActive`:
- On: Entry Browser filters to entities passing
  `entityHasSecretsFor`, force-expands category/subtype groups
  (exactly the existing `searchActive` mechanics). Button gets an
  active/highlighted style + the list gets a subtle mode tint so it's
  unmistakable the view is filtered. Activating clears the search box.
- Off (click again, or typing in the search box): normal list.
  Search and secrets mode are mutually exclusive.

## Part B — Lore Drops

A "Loot Drop" is just a Lore Drop whose elements are Equipment — no
separate mechanism (this is why Lore Drops precede encounter-builder
integration: loot drops fall out for free).

### B1. Recording mode

"+ New drop" button in `#codex-list-actions`, left of "+ New entry",
GM view only. Opens a floating draggable semi-transparent panel
(gallery-picker-panel pattern): title line "Recording any visibility
changes made in the Codex:", a running change log, a Batch name text
input, Save/Cancel.

Mechanics — read-time overlay, zero Firestore writes:
- `state.dropRecording = { changes: [], overlay: {key: {from,to}} }`,
  key = `<type>:<id>`.
- sharing.js interception: while recording, `shareEntityVisibility` /
  `shareLoreItemVisibility` / `shareImageVisibility` do NOT write.
  If the patch touches ONLY visibility-family fields
  ({visibility, characterId, characterShared}), the transition is
  recorded ({elementType, elementId, entityId, label, isMap (images),
  from, to}; a re-toggle of the same element keeps the original `from`
  and updates `to`) and the overlay updated. Combined content+
  visibility saves (lore edit box) write through UNCHANGED and are not
  recorded — documented v1 limitation; the intended recording gestures
  are the quick toggles/kebab. `createLoreItemShared` (born-shared new
  items) also writes through (creations aren't "changes").
- visibility.js exports `resolveDropOverlay(element)` (returns element
  or a merged copy) and applies it at the top of canSee /
  visibilityBadge / isShareableToWholeParty / visibilityStateClass /
  isSharedWithActiveCharacter — every render surface reflects the
  recorded state automatically (the grep-gate invariant is what makes
  this safe). The four buildVisibilityControl call-site getters also
  route through the resolver so the toggles themselves reflect it.
  Pure read-time overlay ⇒ snapshot refreshes can't clobber it.
- Change-log lines use existing badge visual language:
  Hidden → Visible, Hidden → [character badge], etc. State labels:
  gm-only = Hidden; all-players OR character+shared = Visible;
  character (unshared) = the character's badge.
- Save: writes a `loreDrops` doc, clears recording ⇒ overlay drops ⇒
  everything visually reverts. Cancel: clears recording only. Save
  with an empty change list or empty name is blocked inline. Soft cap
  400 changes (Firestore batch headroom at Run).

### B2. Data model + rules

New GM-only collection `loreDrops`:
`{ name, status: 'current'|'previous', changes: [...as recorded...],
   createdAt, ranAt }`
Rules: `allow read, write: if isGM();` (same as encounters). Added to
both backup COLLECTIONS lists.

notifications rules: kind gains `'lore-drop'`; keys gain `dropName`
(string) + `entityIds` (list); the entityId-required clause exempts
this kind.

### B3. Stables tab

New GM-only nav tab "Stables" between Encounters and Admin (more
Stables content to come in later phases; Lore Drops is its first
resident). Layout mirrors Encounters: browser pane left with
Current/Previous sub-tabs listing drops (name + change count + date),
detail pane right summarizing the selected drop's changes (same
badge-language lines as the recording log), with buttons:
- Run (Current only): one writeBatch applying every change's `to`
  (+updatedAt on entities/loreItems; bare patch on images; if an image
  change has isMap, the owning entity's mapImageVisibleToPlayers is
  synced in the same batch, extended §3.1 semantics) + consolidated
  notifications + `{status:'previous', ranAt}`. `from` recorded at
  record time is NOT re-read (a later Undo restores record-time state,
  clobbering interim manual changes — accepted).
- Undo (Previous only): batch applying every `from` (+ map sync) +
  `{status:'current', ranAt:null}`. Silent — no notifications.
- Delete (either): confirm + delete doc.

New module `public/js/stables.js`; GM-only listener
(`loreDropsUnsub`) attached from auth.js's GM branch alongside
encounters (listeners.js invariant 1).

### B4. Consolidated notification

Run writes ONE notification per newly-exposed player (never the GM):
`{recipientEmail, kind:'lore-drop', dropName, entityIds, createdAt,
seenAt:null}`. Recipients/entityIds derived per change via the
existing exposedEmailSet before/after diff (universe =
playersUniverse()); child elements map to their parent entity and are
gated on the recipient seeing the parent in the POST-drop state (the
drop may reveal the parent in the same batch). entityIds deduped.

Campaign digest (messages.js) renders kind 'lore-drop' as its own
card (not entity-grouped): "Lore drop: through *dropName* you have
discovered [entity links...]" — links reuse the existing
switchToCodexTabForEntity click-through, entities gated on canSee at
render time.

## Out of scope / accepted limitations

- Combined content+visibility saves during recording bypass recording
  (write through).
- Undo restores record-time `from`, not pre-Undo state of interim
  edits.
- Run/notification fan-out is single-batch, capped by the 400-change
  save guard.
- No player-facing surface for drops themselves; players only see the
  resulting visibility changes + the notification.
