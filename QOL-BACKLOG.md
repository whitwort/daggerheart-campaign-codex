# QOL Backlog

Future quality-of-life improvements, not currently scheduled into a phase.
Carry this file forward in context-handoff docs.

## ⚠️ Standing design principle — read before touching any button/select CSS

**Gregg has asked for this note to be emphasized: he wants to only
have to specify exceptions going forward, not repeatedly ask for
button consistency. Treat the rule below as binding for all future
work, not just Phase 11.**

**Every button in this app must be the same width and the same
height, with NO per-context exceptions, except:**
1. The landing-page Sign in with Google / Sign in with GitHub buttons
   (`#signin-buttons button`) — deliberately larger, primary CTA.
2. Flat tab-style buttons that are visually tabs, not action buttons —
   no border, no background, no box-shadow: main nav (`nav#tabs
   button`), Entry Card tabs (`#codex-detail-tabs button`), Admin DB
   tabs (`#admin-db-tabs button`).
3. Inline text-link-style buttons — no border, no background, styled
   as a link: `.related-chip`, `.entity-map-link`,
   `.map-breadcrumb-link`, `.collapse-toggle`.
4. Small icon-only circular buttons — `.image-lightbox-close`,
   `.vis-kebab-btn` (Phase 14 S2, the GM 3-state visibility control's
   "..." menu).
5. Buttons inside a small floating panel too narrow for the fixed
   13rem width — `.gallery-picker-body button` (Set portrait / Set map
   picker panel — shared by both since they were unified onto one
   panel pattern).
6. Buttons inside a narrow table cell too narrow for the fixed 13rem
   width — `#admin-players-table button` (Edit/Remove/Save/Cancel in
   the Manage Party row-actions column; two 13rem buttons overflowed
   the card edge). Fixed at `6rem` so Edit/Remove/Save/Cancel are all
   the same width as each other (not just narrower than 13rem).
7. Map pin action buttons — `#map-new-pin-btn, #map-edit-pin-btn,
   #map-remove-pin-btn`, all three matching, sized to fit the longest
   label ("Remove pin").
8. Entry-card action buttons — `.action-btn-compact` (lore item
   Edit/Delete, + New lore, entity-level Edit/Delete, gallery + New
   image), all matching, sized to fit the longest label ("+ New
   image"). Reuse this class for the future Notes-tab "+ New Note"
   button (see below).
9. `#sign-out-btn` and `#codex-new-btn` — single buttons, no group to
   match, `width: auto; min-width: 0;`.
10. Pin panel Save / Move pin / Cancel — `#pin-panel-actions button`,
    all three matching, sized to fit the longest label ("Move pin"),
    not the app-wide 12rem — grouped bottom-right rather than
    stacked, matching the portrait-picker panel's button treatment.
11. Timeline tab rows — `.timeline-row` — full-width flat rows (not
    action buttons), one per dated Scene/Event, click-to-navigate to
    the Codex entry. `width: auto; min-width: 0; text-align: left`
    override, same pattern as `.related-chip`.
12. Admin Sources list Edit/Remove/Save/Cancel — reuses
    `.action-btn-compact` (exception 8) rather than a new exception;
    the default 12rem width caused two side-by-side buttons to overflow
    the Admin card's `.admin-source-row`.

Base width lowered from 13rem to 12rem as of the "+ New party member"
→ "+ New member" rename (that label no longer defines the floor).
"Delete map image" (17 chars) is now the longest surviving
default-width label ("Move pin position" was the other one, but it's
since moved into exception 10 above, renamed to "Move pin", and no
longer uses the default width at all) — 12rem was sized to still fit
 them without wrapping. Flag if those two should also get
their own narrower exception or shortened text.

## Future: Notes tab "+ New Note" button
Add a "+ New Note" button to the Notes tab, styled with the
`.action-btn-compact` class (exception 8 above) so it matches the
lore/gallery/entity-card action buttons. Not yet implemented — no
"add a note" flow exists on that tab yet. Explicitly deferred to
Phase 14 (that's when the Notes tab itself gets built out as part of
player-facing contribution features) rather than done standalone now.

This was corrected piecemeal across many earlier Phase 11 sessions
(gallery Delete, lore Edit/Delete, admin buttons/dropdowns, map pin
buttons, related-entities Add/Remove...) — each fix caught one more
button that had drifted, none of them addressed the root cause. Fixed
for real, in exactly two places, as of the button-width-consistency
pass:
- **Height**: the base `button` rule didn't declare `font-size`, so a
  button sitting in a context with a different ambient font-size (e.g.
  inside `.lore-item-body` at 0.906rem) rendered at a different
  computed height even with identical padding/line-height. Base
  `button` rule now sets `font-size: 0.9rem` explicitly; `select`
  mirrors it.
- **Width**: the base `button` rule sets `width: 13rem; min-width:
  13rem; text-align: center;` — a **fixed** width, not just a floor.
  An earlier pass used `min-width: 6rem` alone and still produced
  visibly mismatched buttons ('+ New image' vs 'Edit'/'Delete' right
  below it) — `min-width` only guarantees a button is *at least* that
  wide, so any label needing more room than the floor (e.g. '+ New
  party member', the longest label in the app) still made that one
  button wider than its neighbors. `width` (with `min-width` matching,
  so a longer-than-13rem label — none currently exist — would still
  grow rather than clip) is the only way to get true uniform width
  regardless of label length. 13rem was sized to comfortably fit '+
  New party member' with margin to spare; shorter labels (Save,
  Cancel, Edit) are now visibly padded out to match, which is the
  necessary trade-off of literal uniform width across very differently
  ­sized labels — flag if this trade-off (space efficiency) should be
  revisited in favor of per-group JS-measured equal-width instead.
  Every previous container-scoped min-width (`#codex-detail button`,
  `#map-gm-controls button`, the file-upload pseudo-button) was
  removed/aligned to inherit this one value instead of maintaining its
  own.

**Any new button added anywhere in the app automatically gets correct
width/height for free — do nothing.** Only add `width: auto; min-width:
0; text-align: left;` (and usually `box-shadow: none; background:
none; border: none;`) if the new button belongs to one of the 4
exception categories above — **both properties are required**; an
earlier attempt at this list reset only `min-width: 0` on the
exceptions and missed that the base rule's fixed `width: 13rem` still
applied via cascade fallthrough (a selector that doesn't declare
`width` doesn't block a less-specific rule that does), so every
'excepted' flat/tab/link button was still forced to 13rem until this
was caught and fixed. If a 5th exception category becomes necessary,
add it to this list explicitly rather than leaving it implicit in
scattered CSS.

## Phase 10 (map improvements) — CLOSED

- **10a. Map image compression too aggressive — DONE** (`b14a299`).
  Quality-search encode ([95,92,88,85,80,75], keep first fit under
  750KB) replaced fixed q85. Applies to map + gallery uploads (shared
  `processImageFile`). Confirmed sharper text on a real trade-map test
  image (q85→379KB vs q95→700KB, same source).
- **10a-bonus. Map legend scoped to categories present — DONE**
  (`b414066`, empty-state fix `ff14f18`). Legend rebuilds every
  `renderPins()` from the same filtered (gm/player-visibility) pin set,
  hides entirely when nothing to show.
- **10b. Pin-safety on Location map image change — DONE.** Both upload
  (replace) and delete now warn when the location has existing pins:
  upload shows a confirm naming the pin count before the new image is
  set (pins are stored in the old image's pixel coordinate space, so a
  replacement can misalign them); delete's existing confirm now also
  names the pin count instead of a generic warning. Both read live
  from `state.allPins` filtered by `mapEntityId === entity.id`. No
  guided re-check/relocate UI (that idea from the original note is
  still just an idea, not built) — this is the warning-only version,
  which is what was asked for.
- **10c. Map tiling — explored, shelved.** Rabbit-hole scope worked out:
  client-side pyramid generation, new `tiles` sub-schema (50-150+ docs
  per map upload, writeBatch chunking + orphan-on-interrupt risk),
  `L.GridLayer` subclass with tile fetch/cache, and it collides with the
  still-open 10b pin-coordinate-space question. Multi-session feature,
  not a session extension of 10a. Quality-search (10a) already fixed the
  test case that prompted this; remaining fuzziness on some maps at
  zoom is accepted as a known limitation for now. Revisit only if a
  specific map still has a real legibility problem 10a can't reach —
  proven in practice, not pre-built speculatively.

## Dev ergonomics

- **Dev-only test Player login (2FA friction) — RESOLVED.** No longer
  an issue; Option A (separate non-private browser app for the second
  Google account, separate cookie jar) held. Option B (Email/Password
  provider gated to the dev project) was never needed.

## Phase 11 (visual styling) — polish follow-ups

- **Character-select dropdown JS error — open, deferred to Phase 14.**
  Confirmed to persist across multiple types of interactions in player
  view mode. Deferred to the future phase focused on player-view
  (Phase 14 — player-facing contribution features); revisit repro/fix
  there rather than in general Phase 11 polish.

Closed this session: Codex TOC entry-row layout stability (accepted as
good enough), GM-mode 'tab item area' yellow line (accepted as
correct), popup flip-below unverified cases from handoff 10 §3
(circle-pin gap constant, hover-open/trackpad behavior, desktop
scrollbar spot-check — accepted, no further action).

## Future phases (scoped, not started)

**Phase 12 — CLOSED.** All Phase 12/12b work (backup/export/migration
infra, and the SRD import scaffolding + implementation that followed
it) is done and verified. Next up: Phase 13.

- **Phase 12b — SRD data import — DONE, verified end-to-end.** Ingest
  Daggerheart SRD content into the codex, reusing the upstream-repo
  approach already proven in the sibling
  `daggerheart-encounter-builder` project (that repo consumes
  `seansbox/daggerheart-srd`'s pre-parsed JSON rather than parsing the
  SRD PDF itself; this repo does the same, one step further into new
  entity types). Admin tab: Configuration > Campaign Type (Daggerheart
  / Not Daggerheart, gates the tab below) and Data > Import from SRD
  (repo setting, default `seansbox/daggerheart-srd`; "Update entries"
  button). New categories `Ancestry`* (*already existed), `Community`,
  `Game Mechanics`* (*already existed), `Equipment` — the latter two
  carry an optional `subtype` field
  (`abilities`/`beastforms`/`classes`/`domains`/`subclasses` under
  Game Mechanics, plus homebrew `"Aether's Children"`;
  `armor`/`consumables`/`items`/`weapons` under Equipment). Idempotent
  re-run: matched against existing entities by (category, subtype,
  slug) via `state.allEntities`; on match, entity fields + its
  `kind:'imported'` lore item are rewritten fresh rather than
  duplicated. All SRD-imported content is `visibility: 'all-players'`
  (public rules text, not campaign secrets). Entry Browser groups
  subtypes as a nested collapsible ToC level under their category.
  Manual subtype editing is also in place — both the inline entity
  edit form (Game Mechanics/Equipment categories) and the bulk JSON
  paste importer accept `subtype` — not SRD-import-only. Source files:
  `public/js/srd-import.js` (fetch/parse/map/upsert), `public/js/
  admin.js` (Campaign Type + SRD tab wiring), `firestore.rules`
  (`subtype` added to `isValidEntity()`'s allowed keys),
  `public/js/codex.js` (subtype edit field + ToC nesting),
  `public/js/import.js` (subtype in bulk import). Deliberately
  deferred, not a bug: no de-dup handling for two records *within the
  same SRD type* that happen to share a name/slug — would silently
  overwrite as an "update." Hand-vet the data if this ever comes up
  rather than building detection speculatively.
- **Dates & Timeline — first pass DONE (interjected before Phase 13).**
  Normalized date notation (y/d/h/m tokens, epoch = campaign start,
  1-indexed forward / literal-magnitude backward, spec locked with
  Gregg) parsed and validated by `public/js/dates.js`
  (`parseDateSpec`). Scene/Event entities get a `dateSort` field
  (signed integer, internal sort key only, 64/64/16/256 s/m/h/d/y
  ratio) computed on save in both the inline edit form (`codex.js`)
  and bulk JSON import (`import.js`); bad syntax blocks save with an
  explanation. New Timeline tab (`public/js/timeline.js`) lists dated
  Scene/Event entities chronologically, click-through to the Codex
  entry, links to a "Dates and Time" lore entry (Game Mechanics >
  Aether's Children) for the player-facing explanation — entry
  content drafted, not yet created in Firestore as of this session.
  Not done: retroactive dateSort backfill for any pre-existing
  Scene/Event entities that already have a free-text `date` but predate
  this feature (none currently known to exist, but not verified).
- **Sources / attribution — DONE (interjected before Phase 13).** New
  `sources` collection (GM-defined list, {text: markdown}), CRUD in a
  new Admin > Sources card (`public/js/sources.js` data layer +
  `admin.js` UI). `sourceId` (dropdown-picked, nullable) added to
  entities, loreItems, and gallery images. Shown to players: a subtle
  muted Markdown label, lower-left of the entity card / lore item well /
  gallery item. Every Hidden->Visible toggle (entity, lore item, gallery
  image) now confirms before proceeding if the entry has no source set
  (`confirmRevealWithoutSource`). Not done: bulk JSON import
  (`import.js`) and SRD import (`srd-import.js`) don't set sourceId —
  SRD-imported content in particular probably wants an auto-assigned
  "Daggerheart SRD" source once one exists, revisit if it comes up.
  Also not done: the map-pin preview-card popup (buildEntityPreviewCard)
  doesn't show the source label — deliberately skipped as a secondary/
  pared-down view, not one of the primary surfaces asked for.
- **SRD import auto-source — DONE.** `srd-import.js` self-configures a
  fixed source, `Daggerheart SRD/Darrington Press: <www.darringtonpress.com/license>`,
  found-or-created (by exact text match against `state.allSources`) at
  the start of every "Update entries" run — no manual Admin > Sources
  setup needed first. Applied to every created/updated SRD entity and
  its `imported` lore item. Bulk JSON import (`import.js`) deliberately
  left alone — arbitrary pasted content has no fixed source to
  auto-assign.
- **Meta field extended to entities — DONE.** Originally lore-item-only
  (handoff 13 session); now entities also carry a `meta` boolean
  (default false), editable via a toggle in the entity edit form (below
  Tags). Displayed as a small fear-colored "Meta" pill: on the entry
  card, same line as Tags, before them; on lore items (GM view), left
  side of the visibility-toggle row, mirroring the toggle's own position
  on the right. Not done: player-view lore items (no toggle row exists
  there to align against) and gallery images don't show a Meta pill —
  not asked for.
- **Source label placement fix — DONE.** Was near the entity card
  heading (not "lower-left of container" as intended); moved to below
  the GM Edit/Delete row (still lower-left; GM Edit/Delete stays
  lower-right). Lore item source label similarly moved to after its
  Edit/Delete row, not before.
- **Source dropdown overflow fix — DONE.** `.source-select` now has
  `width:100%; max-width:18rem; min-width:0; box-sizing:border-box;` —
  was unconstrained, and long option text (up to 60 chars) plus missing
  `min-width:0` on flex ancestors let it push wider than its container
  (worse for the lore-item-source-row flex context than entity edit
  mode). `plainTextPreview` truncation also shortened 60->36 chars.
- **Source ordering + drag reorder — DONE.** Sources now carry a GM-
  controlled `order` field, used everywhere a source dropdown is built
  (`buildSourceSelect`) and in the Admin Sources list itself
  (`sortedSources()` in `sources.js` — missing-order sources, i.e. only
  ones predating this feature, sort last, tiebroken alphabetically).
  Admin > Sources rows got a drag handle (`.source-drag-handle`, "≡")
  wired to SortableJS (`handle:` option, so dragging the markdown text
  itself doesn't start a drag) — same lazy-CDN-load pattern as the
  Gallery tab's reorder, sharing `state.sortableModulePromise`.
  `reorderSources()` batch-writes 0..n-1 on drop.
- **Redundant source label suppression — DONE.** `renderSourceLabel`
  takes an optional `containingEntitySourceId`; if a lore item's or
  gallery image's own source matches its entity's, the label is hidden
  as redundant — data is untouched, this is display-only. Entity cards
  themselves have no "containing" comparison (nothing above them).
- **Phase 13 — Offline / degraded connectivity.** Missed opportunities
  for offline experience and handling intermittent connectivity at the
  table. Prod database backup/snapshot/export strategy folds in here.
  Relevant data point from Phase 11 debugging: the app currently does
  a full re-render on every Firestore snapshot (e.g.
  `renderDetailForSelected()` rebuilds the whole detail card
  wholesale) — this raced with an in-flight click at least once (the
  intermittent "Set portrait needs two clicks" bug). A
  reconnect-and-catch-up snapshot mid-interaction will hit this same
  pattern harder than normal live use does, so this phase should
  budget time for listener/render resilience, not just connectivity
  detection and caching.
- **Phase 13 — Offline / degraded connectivity — CLOSED, dev-verified only.**
  Core work (persistentLocalCache, connectivity.js, header status pill,
  entity-edit conflict banner) done in earlier sessions (handoff 18 and
  prior). This session's work was mostly QOL/bugfix/polish, not phase
  work, but touched adjacent surfaces: Set portrait/Set map UX unified
  onto one shared docked-panel pattern (was two different UIs), a real
  player map-visibility leak fixed (loadMap querying images with no
  visibility check at all, independent of any UI-level icon gating),
  the "Map container already initialized" Leaflet race, and a stale-
  cache role-namespacing gap that could repaint a GM's own cached
  gm-only map image when toggling Preview-as-player. **Prod persistence
  rollout is still pending** — everything above has only ever run
  against the dev Firebase project; needs an explicit go/no-go before
  Phase 14 work lands on top of it.
- **Phase 14 — Player-facing contribution features.** Character
  management, in-app GM messaging at the table, codex-unlock
  notifications, and other ways players contribute directly rather than
  read-only. Highest risk (auth/rules changes). Should explicitly
  inherit Phase 11's established UI conventions (button-width standing
  rule, `.action-btn-compact` pattern, preview-card visual language,
  portrait-picker-style floating draggable panel pattern) rather than
  reinventing them.

## Time-range Scenes/Events (start-end, not just a single point) -- done
Implemented: optional `dateEnd`/`dateEndSort` alongside the existing
`date`/`dateSort`, edit UI field, meta-line range display, and a span
bar + end-cap on the Timeline well. Known limitation carried forward:
clustering and off-screen culling still key off the start point only
-- an entity's end never affects whether it's grouped into a cluster,
and a very long span scrolled so only its start is off-screen could
disappear early. Bulk Admin JSON import doesn't support setting a
range yet (import.js untouched).

## Duplicate exact Scene/Event date warning -- interactive path only
Done for the interactive edit path (see saveEntityEdit in codex.js --
warns via confirm() when a Scene/Event's date resolves to the exact
same `dateSort` as another existing Scene/Event; doesn't block, since
exact ties are legal data the Timeline's cluster-picker already
handles). The bulk Admin JSON import equivalent is explicitly OUT OF
SCOPE (Gregg's call) -- not planned.

