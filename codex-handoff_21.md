# Codex Handoff 21

HEAD at end of session: `a8370ed409435ce4254e1fd0314e43e33091d0fe` (verify
against `git log -1` on fresh clone). Supersedes `codex-handoff_20.md`. CI
green, deployed to dev.

## Session summary

**Phase 14 S1 — done.** Full scope per `phase-14-design.md` §8's S1 row:
schema deltas, full `firestore.rules` rewrite, `visibility.js`
(`canSee`/`viewerContext`/`visibilityBadge`), `sharing.js` write seam,
every §5.1 read-site migration, §5.2 write-site migration, subclass
`featureGroups` audit. Single commit, pushed clean (no rebase needed),
CI green.

## What landed

- **`public/js/visibility.js` (new)** — `canSee(element, ctx)` is now the
  single effective-visibility function per the design doc's truth table
  (§4). Also exports `viewerContext()`, `visibilityBadge()` (unused until
  S4, reserved), `isShareableToWholeParty()` (viewer-independent "would
  the whole party see this" — used for the `mapImageVisibleToPlayers`
  denorm flag AND for GM-facing literal-state displays like toggle
  checked-state/hidden-badges), `visibilityStateClass()` (3-state CSS
  class, only `vis-visible`/`vis-hidden` reachable until S2 adds
  `vis-character` styling).
- **`public/js/sharing.js` (new)** — `shareEntityVisibility`/
  `shareLoreItemVisibility`/`shareImageVisibility`. Every existing
  visibility-toggle write site now routes through here. Header comment
  documents the known-exempt literal-default writes (new-entity/new-image
  creation, bulk/SRD import) that deliberately stay direct. **This is the
  seam S6 hooks notification fan-out into — don't bypass it in S2-S7.**
- **`codex.js`/`map.js`/`timeline.js`** — every `gmView`-boolean-threading
  call site renamed to thread `ctx` (from `viewerContext()`) instead, and
  every surface-local `.visibility === 'all-players'` comparison replaced
  with `canSee()`/`visibilityStateClass()`/`isShareableToWholeParty()`.
  Includes the actual Phase 13 pixel-level map-image security gate
  (`map.js` `loadMap`'s snapshot handler) — now `canSee()`-based, so a
  character-shared map image will work correctly once S3 wires
  preview-as-character. `isEntityPlayerVisible(entityId)` kept as an
  exported shim (builds its own `ctx` via `viewerContext()`) purely for
  `map.js`/`timeline.js` — codex.js's own internal call sites call
  `canSee()` directly since they already have `ctx` in scope.
- **`images.js`** — `setGalleryImageVisibility` moved into `sharing.js`
  verbatim (map-sync batch intact). `setEntityMap`'s
  `mapImageVisibleToPlayers` computation extended to the §3.1
  character-shared semantics via `isShareableToWholeParty`.
- **`state.js`/`auth.js`** — `state.activeCharacterId` added, wired live
  off the *existing* `players/{email}` `onSnapshot` listener (no new
  listener needed, per the design doc's note that this comes "for
  free"). Reset to `null` on every auth change; repopulated by the
  listener for an actual player.
- **`firestore.rules`** — full rewrite:
  - `isValidEntity()` whitelist gains `characterId`/`characterShared`/
    `badgeColor`/`cards`; `visibility` enum gains `'character'`.
  - `isValidLoreItem()` whitelist gains `characterId`/`characterShared`;
    `kind` enum gains `'note'` (and *tolerates* the legacy `'player-note'`
    value defensively, even though Gregg confirmed no real data uses it
    — cheap insurance against a stray test doc); `authorType` now
    strictly `'gm'|'character'`; `visibility` enum gains `'character'`.
  - **`isValidImage()` created for the first time ever** — `images` had
    zero shape validation before this session.
  - New `ownsCharacter(charId)` helper (1 `get()` call) backs every new
    player write path.
  - Player write paths added on `entities`/`loreItems`/`images`: create/
    edit/delete an owned Character and everything under it; edit
    (not delete) `content`/`sourceId`/`characterShared` on an element the
    GM shared with the player's active character; full CRUD on own notes
    (`loreItems` `kind:'note'`).
  - `players/{email}` gains a player-writable `activeCharacterId` field
    (own-doc only, `affectedKeys().hasOnly(['activeCharacterId'])`).
  - New collections, each with full read/write rules per §7:
    `transferRequests`, `threads/{playerEmail}` +
    `threads/{playerEmail}/messages` (first subcollection in this app —
    messages are immutable, no update/delete at all), `notifications`.
  - **`isOwnPlayerNoteWrite()` removed wholesale** (contradicted the
    character-authorship model; confirmed never exercised by any UI).
- **`templates.js`** — audited the subclass `featureGroups` schema
  against live SRD data (fetched `subclasses.json` directly): the SRD's
  `foundation`/`mastery`/`specialization` keys already match the schema
  exactly. **No change needed** — the §3.6 audit item is closed.

## Verification run this session

- ESLint (`eslint@8 --no-eslintrc -c .eslintrc.check.json`): clean.
- `node --check` on every `public/js/*.js`: clean.
- CSS brace balance: 463/463 (untouched — S1 made no UI changes).
- Rules brace/paren balance: 63/63 braces, 253/253 parens.
- Design doc's own grep-gate (`grep -n "=== 'all-players'\|!== 'all-players'"
  public/js/*.js`): passes — zero surviving matches outside
  `visibility.js`/`sharing.js` (the canonical implementation) themselves.
- CI: green, deployed to dev.

## NOT done — explicit gap

**The rules test matrix (§7's "one allowed + one denied case per row,
exercised from both a GM and a player session against the dev project")
was not run.** This sandbox has no Firestore emulator available (no
Google API domains in the network allowlist, and standing up the Java-
based emulator wasn't attempted given that constraint) and no live
Firebase Auth session to test against. The rules file passed static
brace/paren balance and was written carefully against the design doc's
own per-row sketch, but it has **not been exercised against real reads/
writes**. This needs to happen — either Gregg manually runs through the
matrix against dev (open two browser sessions, GM + a whitelisted test
player, try each allowed/denied case in §7's table), or a future session
sets up `firebase emulators:exec` locally if that becomes feasible.
**Do not treat the rules rewrite as verified until this happens** — a
rules bug here is the actual security surface the design doc flagged as
this session's biggest risk (R1).

## Remaining work

- **Rules test matrix** (above) — should happen before S2 starts building
  UI on top of these rules, even though S2 doesn't strictly depend on the
  new player write paths being correct (S2 is GM-only 3-state UI).
- **S2 next**: GM 3-state visibility UI — kebab popover, state machine,
  seafoam CSS vars, `vis-character` class styling (the JS-side
  `visibilityStateClass()` plumbing for it already exists from S1),
  `visibilityBadge()` rendering primitive (already exported, unused).
- Prod persistence rollout (Phase 13, still pending) and Phase 15 (all
  prod work) — unchanged, still deferred.
- QOL backlog — unchanged from handoff 20, not touched this session.

## Session ritual reminder

`rm -rf /home/claude/daggerheart-campaign-codex && git clone
https://<PAT>@github.com/whitwort/daggerheart-campaign-codex.git` →
verify HEAD matches this doc → set git identity → read `QOL-BACKLOG.md`
**and `phase-14-design.md`** (still the locked contract for S2-S7) before
any work. S2 should re-read this handoff's "NOT done" section first.
