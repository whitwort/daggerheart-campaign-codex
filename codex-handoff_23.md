# Codex Handoff 23

HEAD at end of session: `4e7c14c` (verify against `git log -1` on fresh
clone). Supersedes `codex-handoff_22.md`. CI: green, deployed to dev
(confirmed via Actions API poll, both commits below).

## Session summary

**Phase 14 S3 — done.** Player authority per `phase-14-design.md` §6.2:
owned-Character edit affordances, shared-element edit + `characterShared`
toggle, `activeCharacterId` + nav dropdown, live re-filter on switch,
`preview-as-(player,character)` state shape.

No `firestore.rules` changes this session — S1 already wrote every write
path S3's UI now exercises (verified against §7 line-by-line before
starting any code).

## What landed

- **`visibility.js`** — `state.gmPreviewAsPlayer` (bool) replaced by
  `state.gmPreview` (`null | {playerEmail, activeCharacterId}`) per §5.3;
  `viewerContext()` resolves `activeCharacterId` correctly for both a
  real player and a previewing GM. Two new exports:
  - `hasFullAuthority(element, ctx)` — GM or owns the parent Character;
    full edit/delete rights, same as GM gets.
  - `isSharedWithActiveCharacter(element, ctx)` — element is
    `visibility:'character'` targeted at the viewer's own active
    character; the reduced edit-not-delete tier.
- **`visibility-ui.js`** — `buildSharedToggle()`: lightweight switch-only
  control (no kebab) for the player's own `characterShared` flip, reuses
  existing `.toggle-switch`/`.toggle-slider`/`.toggle-switch-label`
  classes (no new CSS needed).
- **`codex.js`** (the bulk of the diff):
  - **Nav "Character" dropdown is now functional** —
    `player-character-select` lists the player's owned Characters
    (`renderPlayerCharacterSwitcher()`, called from `updateGmToolbar()`
    every render) and writes `players/{email}.activeCharacterId` on
    change. No optimistic local write — the live `playerDocUnsub`
    listener in `auth.js` is the single source of truth.
  - **GM preview toggle** now writes the new `state.gmPreview` object
    shape (`{playerEmail:null, activeCharacterId:null}` — no
    specific-player picker yet, that's S5's Characters-tab flipper).
  - **Entity edit form**: category and "Owned by party member" selects
    are now GM-only (hidden entirely for a non-GM editor, replaced with
    a static category label) — rules already reject a diff touching
    either field, this just matches the UI to that. `buildParentSelect`/
    `buildRelatedEditor`/the Ancestry dropdown now filter
    `state.allEntities` through `canSee` for non-GM viewers, so a
    hand-added gm-only entity can't leak its name into a player's
    dropdown.
  - **Entity view/edit chrome** (visibility toggle, Edit/Delete row):
    gated on `hasFullAuthority` instead of bare `ctx.gmView`. An entity
    itself shared to the viewer's active character (not owned) gets
    *only* a `characterShared` toggle in place of the full kebab, no
    content edit and no Delete — this matches a deliberate asymmetry in
    §7's rules table (entities' shared-edit rule only allows
    `characterShared` in `affectedKeys`; loreItems/images additionally
    allow `content`/`sourceId`).
  - **`renderLoreTab` rebuilt** from a single `gmView`/`readOnly` branch
    into a per-item three-tier render: `entityAuthority` (full,
    GM-equivalent — kebab, drag-reorder, Edit/Delete, "+New lore"),
    `itemShared` (new `buildSharedLoreEditBox()`/`saveSharedLoreItem()`
    — content+source edit, `characterShared`-only toggle via
    `buildSharedToggle`, no delete, no kebab), read-only (unchanged
    look). `itemShared` is reachable even on an entity the player
    doesn't own (e.g. one lore item on a GM-owned NPC shared to a
    specific PC). Player-authored lore added under an owned Character
    now sets `authorType:'character', authorId:<the character's own
    entity id>` instead of the GM's `authorType:'gm', authorId:null` —
    threaded through `editState.authorType`/`authorId` at "+New lore"
    time, consumed in `saveLoreEdit`'s `isNew` branch.
  - **`renderGalleryTab`**: `showChrome` now includes owned-Character
    authority (unlocks upload/Set portrait/Set map/delete for an owning
    player, no new code needed there — those dialogs had no embedded
    role checks to begin with). Shared images get a reduced footer
    (characterShared toggle + source select only, no delete).
  - `notifyVisibilityChange` now exported (was module-private).
- **`firestore.rules` / `codex.js` (follow-up commit `4e7c14c`)** —
  `kind:'character-lore'` split out as its own enum value for
  player-authored owned-Character lore, replacing the `gm-note` reuse
  from the first commit (Gregg's call: that name was actively misleading
  once a player can author these too). `gm-note` now unambiguously means
  GM-authored; existing docs untouched, no migration.
  `phase-14-design.md` §3.2 updated so S4 sees the addition when it
  re-reads the doc.
- **`auth.js`** — `playerDocUnsub`'s snapshot handler now calls
  `notifyVisibilityChange()` every time (not just `updateAccessUI`), so
  switching active character live-refilters Map/Timeline too, not only
  the Codex list/detail (D2's "live re-filter" requirement — the old
  code only triggered `renderList()`/`renderDetailForSelected()` via
  `updateAccessUI`, which Map/Timeline don't hook into).
- **`map.js`** — image cache (`getCachedImage`/`putCachedImage`) is now
  bypassed entirely during GM preview (`isGmPreview` guard on both read
  and write), per §5.3/R5's recommended simplification, instead of
  adding a character dimension to the cache key.

## Verification run this session

- ESLint (`eslint@8 --no-eslintrc -c .eslintrc.check.json`): clean.
- `node --check` on every `public/js/*.js`: clean.
- CSS brace balance: 480/480 — unchanged from handoff 22 (no CSS touched
  this session; every new control reuses existing classes).
- Design doc's grep-gate (`grep -n "=== 'all-players'\|!== 'all-players'"
  public/js/*.js`): still passes — only matches in `visibility.js`/
  `sharing.js`/`visibility-ui.js`, no new surface-local checks introduced.
- Manually read the full diff hunk-by-hunk against the plan before
  committing (not just the automated gate) — this session touched a lot
  of pre-existing GM-only render logic and I wanted to catch any
  branch-condition mistakes before they hit dev.
- CI: polled Actions API post-push, green, deployed.

## NOT done / open gaps

- **S1's rules test matrix is STILL not run** (carried from handoff 21
  and 22 for a third time — no Firestore emulator or live Auth session
  available in this sandbox). Gregg's explicit call this session: proceed
  without it, defer to a true end-to-end test later.

  Correction from my own first draft of this doc: I'd written this up as
  "more urgent than before" since S3 is the first session where the UI
  drives the player write paths. Gregg's pushback is right — there's no
  natural way to exercise most of it yet anyway, since neither GM nor
  player has a real *character-creation* flow (that's S5). The one path
  that IS mechanically testable today: a GM can assign a test player as
  `ownerId` on a Character entity via the existing (pre-S3) "Owned by
  party member" select in the entity edit form, and that player can then
  pick it as active via this session's new nav dropdown — from there the
  owned-Character/shared-element paths are exercisable. Not the flow a
  real player will use, so waiting for S5's proper creation UI to test
  naturally is the reasonable call, not an oversight to keep flagging as
  urgent.- **No live-dev smoke test this session** — same sandbox limitation as
  every prior Phase 14 session. Before trusting this on dev, Gregg should
  manually verify, ideally as part of finally running the rules matrix:
  - A player can create/edit/delete their own Character entity, but
    can't touch `ownerId`/`category` (no UI to attempt it, but also
    confirm the rules would reject a hand-crafted attempt).
  - A player gets full lore/gallery CRUD under their own Character,
    including the 3-state kebab, and it all looks right on iPad.
  - GM shares a lore item/image/entity to a specific PC (via the S2
    kebab) → that PC's owner sees the reduced shared-edit tier (edit
    content/source, `characterShared` toggle, no delete) and *only* on
    their active character — switching active character in the nav
    dropdown should make it disappear/reappear live.
  - The nav "Character" dropdown populates correctly, persists across
    reload (writes to Firestore, not just local state), and a switch
    re-filters Map/Timeline pins/rows, not just the Codex list.
  - GM preview-as-player still behaves as before (generic characterless
    player simulation) — the `gmPreview` shape change was meant to be
    behavior-neutral for S3 itself.
- **Image "replace" for shared images is not built** — a player editing
  a shared gallery image gets `characterShared` + source only, no way to
  replace the image data itself, even though §6.2's text says "replace
  image" should be in scope. Deliberately deferred: no
  replace-image-binary function exists anywhere in the app yet, GM
  included (delete+reupload is the only existing pattern) — building a
  net-new capability that even the GM lacks felt like scope creep beyond
  "give players GM-equivalent affordances." Flag if Gregg wants this
  built either as a GM feature first or directly for both.
- **`buildSharedLoreEditBox` has no conflict-detection banner** — the
  full GM/owner `buildLoreEditBox` warns if someone else saved the item
  while it was open (Phase 13 pattern); the reduced shared-edit box
  skips this. Low-stakes (a player editing a GM-shared item mid-GM-edit
  is an unlikely collision, and the write only touches content/source
  anyway) but noting the asymmetry.
- ~~**Judgment call, not explicit in the design doc text:** player-authored
  lore items under an owned Character use `kind:'gm-note'`...~~
  **RESOLVED (follow-up commit `4e7c14c`):** split into its own
  `kind:'character-lore'` enum value at Gregg's request. See "What
  landed" above and `phase-14-design.md` §3.2.
- **Entities shared to a specific character but not owned**: confirmed
  the design's own §7 table restricts this to a `characterShared`-only
  toggle (no content edit) and built it that way, but this is a genuine
  asymmetry against loreItems/images that's easy to misremember later —
  flagging it explicitly here in case it turns out to be an oversight in
  the original design doc rather than intentional.

## Remaining work

- **S4 next** (per §8's dependency graph: S1 → S2 → S3 → {S4, S5}
  parallel-safe → S6 → S7): Notes — `kind:'note'`, Notes tab build-out,
  "+New Note" (already reserved as `.action-btn-compact` in
  QOL-BACKLOG.md), cannon flow (`author-only` → `all-players`), Lore-tab
  projection + character badge (`visibilityBadge()` from S1, still
  unconsumed — first real trigger arrives in S4). Re-read
  `phase-14-design.md` §6.3 before starting.
- **S5** (parallel-safe with S4): Characters tab — GM left-rail flipper
  (this is where `state.gmPreview.activeCharacterId` actually gets set
  to something other than null for the first time), player
  list/create/card-slot editor, `transferRequests` + unified Requests
  queue.
- Rules test matrix (§7) — still open, not urgent to force before S4/S5
  per Gregg's correction above; natural to run once S5 gives a real
  character-creation flow to test through.
- S6, S7, prod persistence rollout (Phase 13), Phase 15 — unchanged,
  still deferred.
- QOL backlog — unchanged from handoff 22, not touched this session.

## Session ritual reminder

`rm -rf /home/claude/daggerheart-campaign-codex && git clone
https://<PAT>@github.com/whitwort/daggerheart-campaign-codex.git` →
verify HEAD matches this doc → set git identity → read `QOL-BACKLOG.md`
**and `phase-14-design.md`** (still the locked contract for S4–S7) before
any work.
