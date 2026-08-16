# Codex Handoff 25

HEAD at end of session: `021633c` (verify against `git log -1` on fresh
clone). Supersedes `codex-handoff_24.md`. CI: green, deployed to dev
(confirmed via Actions API poll, head_sha matches).

## Session summary

**Phase 14 S5 — done.** Characters tab (§6.4), unified Requests queue
(§6.5/D8), badgeColor picker (closes the gap flagged in handoff 24).
Per §8's dependency graph this was the second of the two parallel-safe
sessions after S3 (S4 already landed in the prior session) — nothing in
S4 touched anything this session depended on.

Placement call from Gregg at session start: unified Requests queue
extends the existing Admin tab section (not a separate nav element).

## What landed

- **New `public/js/characters.js`** — the whole Characters tab:
  - **GM view**: left-rail flipper of every owned Character entity,
    grouped by player (sorted by displayName then character name).
    Selecting one shows: an ownerId reassign/unassign select (GM-only
    "assignment management," §6.4 — absorbs the Admin party-table's old
    read-only Characters column, see below), the badgeColor picker, the
    card-slot editor, and a read-only "as \<owner\> currently sees it"
    lore preview built from a synthesized ctx.
  - **Player view**: own-character list (name chip + Set active/Active
    label), "+ New character" (creates with `ownerId:self,
    visibility:'gm-only'`, same literal-default convention as every
    other new-entity write in this app; auto-sets as active only if the
    player has no active character yet — never overrides one they're
    already playing), selecting a character shows the badgeColor picker
    + card-slot editor + Delete (D4), and an "Available characters"
    section (unowned + `canSee`-visible Character entities) with
    Request transfer / Cancel request.
  - **Card-slot editor** (ancestry/community/class/subclass+tier/
    abilities, D7): each slot is a `<select>` + a compact stat-card
    (name chip that click-throughs to the Codex entry, plus a Details+
    Features markdown block built locally in this module — see "Design
    decision" below for why it's not a reuse of `buildEntityPreviewCard`
    or codex.js's own `buildDetailsMarkdown`/`buildFeaturesMarkdown`).
    Subclass features are tier-scoped to `cards.subclassTier` (D7's
    whole point). Abilities is a multi-picker mirroring codex.js's
    "Related entries" list+add-select pattern, with the add-select
    grouped into `<optgroup>`s by the ability's `domain` detail key.
    All slot writes go straight to `entities/{id}.cards` via a direct
    `updateDoc` (not routed through sharing.js — these aren't
    visibility/characterId/characterShared mutations, out of scope for
    that seam, not exempt-from-it).
  - **badgeColor picker**: 12-swatch grid reusing the app's existing
    `--cat-*` category-accent CSS custom properties (already a curated,
    visually distinct palette matching the aesthetic — not a new ad-hoc
    color set). Every badge rendered `--seafoam` fallback until this
    session (flagged in handoff 24); real per-character colors now
    available anywhere `visibilityBadge()`/`buildCharacterBadge()` is
    consumed (currently just the Lore tab, from S4).
  - **transferRequests**: this module owns the player-scoped "my own
    pending requests" listener only (`where toEmail==self`, needed to
    gray out/relabel an already-requested "Request transfer" button —
    an unfiltered collection listener is rules-denied for a non-GM,
    same reasoning as joinRequests/players elsewhere). The GM's full
    unfiltered collection listener lives in admin.js (next item).

- **admin.js** — unified Requests queue: `renderAdminJoinRequests` now
  renders BOTH join requests (existing Accept/Reject, unchanged
  behavior) and transfer requests (new Approve — sets the character's
  `ownerId` then deletes the request doc — and Reject) in one list,
  under one heading ("Requests"), with the existing nav badge
  (`admin-pending-badge`) now counting both. New
  `transferRequestsUnsub` listener (GM-only, full collection) added
  alongside the existing `joinRequestsUnsub`/`playersUnsub` in
  `attachAdminListeners`/`detachAdminListeners`. The players listener's
  snapshot handler now also calls `renderCharactersTab()` (the GM
  flipper groups by player displayName, needs a re-render on any
  players change too, not just entities/role).
  Admin party table: heading copy fix per §1's Definitions table
  ("Party ID"/"Party name" → "Player ID"/"Player Name"); the old
  read-only Characters column (`charactersOwnedBy()`) is REMOVED —
  absorbed into the Characters tab per §6.4's explicit "absorbing the
  Admin party-table's character column" language, which now both shows
  AND manages ownership rather than just displaying it.

- **firestore.rules — NO CHANGES.** Checked every write path this
  session's UI exercises against the existing rules file by hand before
  writing any code: transferRequests create/read/delete (own or GM),
  entity create for a player's own new Character (`category=='
  Character' && ownerId==token.email`), `cards`/`badgeColor` writes
  (already in `isValidEntity()`'s whitelist since S1), ownerId
  reassignment (GM's blanket entity-update authority). S1 built all of
  this infrastructure in anticipation of S5 — nothing was missing.

- **`public/index.html`** — Characters tab shell (`#characters-gm-view`
  / `#characters-player-view`, toggled by `ctx.gmView` in
  `renderCharactersTab`), Admin party table header fix, old Characters
  `<th>` removed.

- **`public/css/styles.css`** — Characters tab layout (`.characters-
  layout`/`.characters-list-pane`/`.characters-detail-pane`, natural
  page flow, NOT the viewport-height-fit flex layout `#codex-tab` uses
  — deliberately simpler, no `fitCodexTabHeight`-style JS sizing needed
  since nothing here is a pinned-height map/canvas well), flipper item/
  group-label styles, card-slot/card-editor styles, badge-swatch grid,
  and a new standalone `.character-name-chip` class (see "Bug found and
  fixed" below).

- **`QOL-BACKLOG.md`** — button-width exception 4 (small icon-only
  circular buttons) extended to list `.character-badge-swatch`.

## Design decision: GM flipper's card preview is NOT a second mount of
## the Codex tab's stateful detail card

§6.4 says the GM flipper "renders with a synthesized ctx: that player's
email + that character active" — i.e. shows the character's player-
perspective card view. I did NOT implement this by re-invoking
`renderEntityViewCard` (the Codex tab's real, stateful detail-card
renderer) with a synthesized ctx. That component owns several
genuinely singular pieces of global state — `state.selectedId`,
`state.detailActiveTab`, `state.loreEdit`/`noteEdit`, and critically
`state.entityImagesTargetId`/`currentEntityImages`, which is a single
live Firestore query pointed at ONE entity's images at a time. Two
simultaneously-mounted instances (the real Codex tab selection and this
flipper's preview) would fight over that single per-entity image
listener the moment both are on screen — and they CAN both be on
screen, since tab panels hide via CSS (`display:none`), not by
unmounting.

Instead, `characters.js` builds its own small, fully self-contained
read-only preview (`renderCharacterPlayerEyeView`): just the character's
lore list, filtered through a synthesized ctx via `canSee`/
`belongsOnLoreSurface` (same logic as codex.js's own
`loreItemsForEntity`, reimplemented locally rather than exported from
codex.js, to keep codex.js untouched this session — see below). No
Gallery, no Notes tab, no edit chrome. This is a deliberate
simplification, not an oversight — flagged for Gregg to weigh in on if
full parity (especially Gallery) turns out to matter in practice.

Corollary: the card-slot editor's stat display (ancestry/community/
class/subclass cards) similarly does NOT reuse `buildEntityPreviewCard`
— that function shows only an entity's first raw loreItem verbatim,
never the `resolveLoreItemMarkdown`-synthesized Details/Features view,
so it would have silently shown nothing for a templated Ancestry/Class/
Subclass with no free-text lore item of its own. `characters.js` has
its own compact `slotStatMarkdown()` (Details+Features, tier-scoped for
subclass via `tierFilter`) built from `entity.details`/`entity.features`
directly, mirroring codex.js's `buildDetailsMarkdown`/
`buildFeaturesMarkdown` logic without importing/exporting them (kept
codex.js's export list unchanged this session).

**`codex.js` itself was not touched at all this session** — every new
piece of Characters-tab logic lives in the new module, importing only
what was already exported (`switchToCodexTabForEntity`, `applyWikiLinks`).
Deliberate: kept the largest, highest-risk file out of scope entirely.

## Bugs found and fixed pre-commit

1. **Import cycle / TDZ crash.** `admin.js` importing `renderCharactersTab`
   from the new `characters.js` — combined with `characters.js` importing
   `switchToCodexTabForEntity`/`applyWikiLinks` from `codex.js`, and
   `codex.js` already importing from `admin.js` (line 10, pre-existing)
   — closes a real cycle: `codex.js -> admin.js -> characters.js ->
   codex.js`. My first draft registered `characters.js`'s re-render the
   same way map.js/timeline.js do (`registerVisibilityChangeHandler(
   renderCharactersTab)` at the module's own top level). Traced through
   the actual module-evaluation order (main.js -> map.js -> codex.js as
   map.js's own dependency -> admin.js as codex.js's line-10 import ->
   characters.js as admin.js's import -> back to codex.js, cycle
   detected, live-but-partial binding returned) and confirmed this call
   would execute WHILE codex.js's own top-level evaluation is still
   paused earlier in that same chain, before codex.js reaches its own
   `const visibilityChangeHandlers = []` — a real `ReferenceError`
   (temporal dead zone), not a hypothetical; function declarations are
   safely hoisted across the cycle (that part's fine) but `const`/`let`
   are not. Fixed by moving the `registerVisibilityChangeHandler(
   renderCharactersTab)` call to `main.js` instead, which sits outside
   the cycle (it's the entry point — every module's own top-level code
   has fully finished running by the time main.js's own body executes).
   `characters.js` carries a NOTE comment at the bottom explaining this
   for the next session, since it's an easy trap to reintroduce if this
   module (or a future one) is refactored without re-checking the import
   graph.

2. **`.related-chip` styling didn't apply.** Reused the class name for
   compact name-buttons in three places (card-slot stat display, own-
   character rows, available-character rows) assuming it was a reusable
   class. It isn't — its actual pill styling, including the `width:auto`
   override needed to beat the base `button` rule's `width:13rem`, lives
   entirely under a `.codex-related-chips` ANCESTOR selector (see
   styles.css's own "Specificity note" comment on that block — it's
   scoped that way specifically to out-specificity `.codex-entity-card
   button`). No such ancestor exists in the Characters tab, so the bare
   class silently got none of that styling; every one of these buttons
   would have rendered as a full-width 13rem default button instead of a
   compact chip. Caught by re-reading the diff against the actual CSS
   (not just assuming class-name reuse = style reuse) before committing.
   Fixed with a new standalone `.character-name-chip` class carrying its
   own complete rule — a plain class selector beats the bare `button`
   element selector on specificity alone in this context, so no
   container-scoping trick was needed (unlike the original).

## Verification run this session

- ESLint (`eslint@8 --no-eslintrc -c .eslintrc.check.json`): clean.
- `node --check` on every `public/js/*.js`: clean.
- CSS brace balance: 502/502 (was 500/500 immediately post-fix, 481/481
  at handoff 24 baseline — 21 new rules total across the session).
- Design doc's grep-gate (no surface-local `=== 'all-players'`/
  `!== 'all-players'` outside sharing.js/visibility.js/visibility-ui.js):
  clean — this session's `visibility: 'gm-only'` in the new-character
  literal default is an object-literal value, not a comparison, doesn't
  match the pattern (and shouldn't — it's the same known-exempt literal-
  default class sharing.js's header comment already documents for every
  other new-entity write site; flagging here for the record but not
  adding a new sharing.js exemption line since new-Character creation
  is just one more instance of the SAME existing pattern, not a new
  one).
- `firestore.rules` brace/paren balance: unchanged (63/63, 254/254) —
  file not touched this session, verified anyway per the standing gate.
- Read every diff hunk against the actual rules file and actual CSS
  (not assumed) before committing — both bugs above were caught this
  way, not by the automated gate (ESLint/node --check don't catch either
  class of bug: the TDZ crash is a runtime-only failure the syntax
  checkers can't see; the CSS specificity miss is silently-wrong styling,
  not invalid CSS).
- CI: polled Actions API post-push, green, deployed to dev, head_sha
  confirmed matching.

## Post-session fix: deploy break

`9b21fee` broke the app on dev entirely (both GM and player views,
every load): `characters.js` imported `humanizeKey` from `templates.js`,
which never exported it (templates.js's own copy is internal-only, used
only by `computeSearchIndex` there). Neither `eslint` nor `node --check`
catch a bad named import — it's a browser-native ES module resolution
error, not a syntax error, so it's invisible to the current gate
entirely. Fixed in `021633c`: a local `humanizeKey` copy in
characters.js, matching the existing "kept in sync across codex.js/
templates.js/srd-import.js" convention already documented for this
exact function. Verified this was the ONLY bad import by cross-checking
every named import in characters.js against every target module's
actual export list. CI green, HEAD `021633c` deployed to dev.

**Flag for future sessions**: this bug class (valid syntax, non-existent
named import) is structurally invisible to the pre-commit gate as it
currently stands. Worth considering a standing import-cross-check step
(or an actual headless-browser/module-graph load smoke test) added to
the verification gate, not just a one-off script run after the fact.

## NOT done / open gaps

- **No live-dev smoke test this session** — same sandbox limitation as
  every prior Phase 14 session (no emulator/Auth session available).
  Before trusting this on dev, Gregg should manually verify (in
  priority order, given this session's actual new write paths):
  - **Player creates a character**: "+ New character" as a real player
    session — confirm the entity actually writes (rules exercise this
    for the first time this session, even though I verified it by hand),
    appears in "Your characters," auto-becomes active if it's their
    first.
  - **Card-slot editor round-trip**: pick an Ancestry/Community/Class/
    Subclass/abilities as a player on their own character; confirm the
    stat-card display shows Details/Features correctly, and specifically
    that the subclass tier selector actually changes which Features
    show (D7's whole point — I traced the logic by hand but never ran
    it against real SRD-imported subclass data with populated `group`
    fields).
  - **badgeColor picker**: confirm a picked color actually shows up on
    that character's badge on the Lore tab (S4's cannon-note/
    characterShared consumer) — this is the FIRST time a non-fallback
    badgeColor will exist in real data.
  - **GM flipper + assignment**: confirm the left-rail groups correctly
    by player, the ownerId reassign select actually moves a character
    between players (and that the "as the owner sees it" preview updates
    to the NEW owner's perspective after reassignment), and that
    unassigning drops it out of the flipper.
  - **Transfer request round-trip**: player requests an unowned-but-
    visible character, GM sees it in the unified Requests queue, GM
    Approve actually sets ownerId and removes the request, the requesting
    player's UI updates (myTransferRequests listener) without a reload.
  - **Unified Requests queue**: confirm join + transfer requests both
    render correctly in the same list with correct per-type actions, and
    the nav badge count is the SUM of both (not just one).
  - **Admin party table**: confirm the Characters column is genuinely
    gone and nothing else broke in that table's layout with one fewer
    column.
- **Gallery not included in the GM flipper's "as the owner sees it"
  preview** — deliberate simplification (see Design decision above), not
  a bug. Revisit if Gregg wants full parity.
- **S1's rules test matrix is STILL not run** (carried from handoff
  21-24 for a fifth time). Per Gregg's S3 call this stays deferred to a
  natural end-to-end test — and this session is arguably the best
  opportunity yet, since Characters tab now gives a real character-
  creation flow to test against (the exact trigger condition handoff 24
  named). Strongly worth doing before S6 (Messages/notifications) adds
  even more write surface on top.
- **"Available characters" interpretation is a judgment call, not
  explicitly speced.** The design doc's rules-file comment says transfer
  requests target "an unowned PC" but the schema has no field
  distinguishing an NPC from an available-for-adoption PC (both are just
  `category:'Character', ownerId:null`). Implemented interpretation:
  visibility is the de facto gate — a GM makes an unowned Character
  discoverable for transfer simply by sharing it (same visibility
  controls as anything else); an NPC left at the gm-only default never
  surfaces in "Available characters." Flag if Gregg wants an explicit
  separate flag instead.
- Message tray/notifications (S6), integration polish (S7), rules test
  matrix (§7), prod persistence rollout (Phase 13), Phase 15 — all still
  deferred, unchanged from prior handoffs.

## Remaining work

- **Before S6, strongly recommended**: run the S1 rules test matrix
  (§7). Now deferred five sessions running (handoffs 21-25). Characters
  tab (S5) finally gives real character-creation/transfer/reassignment
  flows to test against — the exact trigger condition handoff 24
  flagged. S6 adds threads/messages/notifications on top — three MORE
  collections with real write paths, none of them verified either. Risk
  compounds every session this stays deferred; this is very likely the
  last reasonable point to catch it before the write surface gets hard
  to test as a single pass.
- **S6 next** (per §8: S1 -> S2 -> S3 -> {S4, S5} -> S6 -> S7; both
  parallel-safe sessions are now done): Messages tray + threads/
  notifications collections + fan-out hooks in sharing.js + Campaign tab
  digest. Re-read `phase-14-design.md` §6.6/§6.7/§7's threads/
  notifications rules before starting. Sonnet-first per the session
  plan; escalate to Fable if fan-out edge cases or the first-
  subcollection listener plumbing (this app's first-ever subcollection)
  bite.
- S7, rules test matrix, prod persistence rollout, Phase 15 —
  unchanged, still deferred.

## Session ritual reminder

`rm -rf /home/claude/daggerheart-campaign-codex && git clone
https://<PAT>@github.com/whitwort/daggerheart-campaign-codex.git` →
verify HEAD matches this doc → set git identity → read `QOL-BACKLOG.md`
**and `phase-14-design.md`** (still the locked contract through S7)
before any work.
