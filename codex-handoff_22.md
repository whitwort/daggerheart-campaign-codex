# Codex Handoff 22

HEAD at end of session: verify against `git log -1` on fresh clone. Supersedes
`codex-handoff_21.md`. CI: pending push/deploy confirmation.

## Session summary

**Phase 14 S2 — done.** GM 3-state visibility UI per `phase-14-design.md`
§6.1: kebab popover, state machine, seafoam CSS vars, `vis-character` class
styling, badge rendering primitive (see gap note below).

## What landed

- **`public/js/visibility-ui.js` (new)** — `buildVisibilityControl(opts)`,
  the single shared builder for the toggle+kebab+popover control, replacing
  four near-identical hand-built toggle blocks. `opts` takes
  `getVisibility()`/`getCharacterId()` getters, `sourceId`, an injected
  `confirmReveal` (avoids a circular import back into codex.js's
  `confirmRevealWithoutSource`), and `onApply(patch)`. Also exports the
  module-private `partyCharacterOptions()` (current-party PCs: category
  `Character` with `ownerId` set, sorted player name then character name,
  player name resolved via `state.allPlayers`, falls back to raw
  `ownerId` if the player was since de-whitelisted). Popover
  open/close is a module-level singleton (one `document` click + keydown
  listener registered once at load, not per-render) so repeated list
  re-renders never pile up duplicate listeners.
- **State machine** (D1 + §6.1): `characterId==null` toggle flips
  `gm-only`<->`all-players`; `characterId!=null` toggle flips
  `character`<->`all-players`, `gm-only` unreachable until "None" is
  picked. Selecting a character always lands on `visibility:'character'`
  regardless of prior state. Selecting "None" -> `gm-only`, clears
  `characterShared`. **Judgment call, not explicit in the design doc
  text:** re-targeting to a *different* character (not "None") also
  clears `characterShared` if the characterId actually changed — a
  player's onward-share consent shouldn't silently carry over to a PC
  who never gave it. Flag if this should be reverted.
- **Reveal-without-source guard**: fires whenever the element leaves
  `gm-only` for the first time, whether landing on `all-players` or a
  specific character — both are new exposure to at least one player.
  Unchanged trigger condition, now centralized in `applyChange()`.
- **Four call sites rewired** in `codex.js`, all now delegate to
  `buildVisibilityControl`:
  - `buildEntityVisibilityToggle` (live write via `shareEntityVisibility`).
  - Lore-item live toggle in `renderLoreTab` GM view (live write via
    `shareLoreItemVisibility`).
  - Lore-item edit box (`buildLoreEditBox`) — local `editState` mutation,
    no live write until Save. `editState.characterId`/`characterShared`
    added and threaded through: both `loreEdit` init sites (existing-item
    edit, new-item draft), the conflict banner's "Reload latest" handler,
    and both of `saveLoreEdit`'s write paths (the `isNew` multi-item
    `addDoc` loop and the existing-item `shareLoreItemVisibility` call).
  - Gallery image toggle (live write via `shareImageVisibility`).
- **`public/css/styles.css`**:
  - `--seafoam`/`--seafoam-glow` root vars (locations-green adjacent per
    the design doc's own hint, brighter/more saturated so it reads as an
    active state not a category tag).
  - `.vis-character` glow/strip rules alongside the existing
    `.vis-hidden`/`.vis-visible` siblings on `.codex-entity-card`,
    `.lore-item`, `.gallery-item`.
  - `.toggle-switch.mode-character .toggle-slider` (seafoam off-state;
    the existing `:checked` rule already wins on specificity so the
    on-state stays fear-colored in every mode — see the CSS comment).
  - `.toggle-switch-label.state-character`.
  - New `.vis-control`/`.vis-kebab-wrap`/`.vis-kebab-btn`/
    `.vis-kebab-popover`/`.vis-kebab-option`/`.vis-kebab-char-name`/
    `.vis-kebab-player-name` — kebab styled as a small icon-only circle
    (same size class as `.search-help-btn`), popover styled the same
    anchored-card pattern as `.search-help-popup`.
- **`QOL-BACKLOG.md`** — `.vis-kebab-btn` added to the button-width
  standing rule's exception category 4 (small icon-only circular
  buttons), explicit per that section's own instruction not to leave a
  new exception implicit in scattered CSS.

## Verification run this session

- ESLint (`eslint@8 --no-eslintrc -c .eslintrc.check.json`): clean.
- `node --check` on every `public/js/*.js`: clean.
- CSS brace balance: 480/480 (was 463/463 at handoff 21 — the +17 pairs
  are exactly this session's new rule blocks).
- Design doc's grep-gate (`grep -n "=== 'all-players'\|!== 'all-players'"
  public/js/*.js`): still passes — only matches in `visibility.js`/
  `sharing.js`/the new `visibility-ui.js` (itself now canonical for this
  rendering primitive, same status as the other two).

## NOT done / open gaps

- **S1's rules test matrix is still not run** (carried from handoff 21 —
  no Firestore emulator or live Auth session available in this sandbox).
  Not blocking for S2 (GM-only UI, no new player write paths), but
  **must happen before S3** starts exercising the new player write
  paths for real.
- **No live-dev smoke test this session** — same sandbox limitation.
  Before trusting this, Gregg should manually verify on dev: GM can put
  any lore element in all three states via the kebab; deselecting
  ("None") lands `gm-only`; the seafoam state is visually distinct on
  iPad (glow ring, toggle color, kebab active state); popover
  open/close/outside-click/Escape all feel right on a touch device
  (this was built and reasoned about but never touched on real
  hardware).
- **`visibilityBadge()` still has no consumer** — S1's comment reserved
  it "until S4," but the design doc's S2 session-plan row also lists
  "badge rendering primitive" as in-scope. Investigated: nothing in S2's
  actual surfaces can currently produce a badge-worthy state anyway —
  the badge only fires for `characterShared:true` (a player's own
  onward-share, S3) or a cannon note (Notes don't exist yet, S4) — so
  there's no live data path to wire it against yet. Left untouched
  rather than wiring a primitive with no real trigger. Revisit when S3
  adds the player `characterShared` toggle.

## Remaining work

- **S3 next**: player authority — owned-character edit affordances,
  shared-element edit + `characterShared` toggle, `activeCharacterId` +
  nav dropdown, live re-filter on switch, preview-as-(player,character).
  Re-read `phase-14-design.md` §6.2 + §5.3 (existing helpers repurposed)
  before starting. Rules test matrix (above) should run before or early
  in this session.
- S4–S7, prod persistence rollout (Phase 13), Phase 15 (all prod work) —
  unchanged, still deferred.
- QOL backlog — unchanged from handoff 21, not touched this session.

## Session ritual reminder

`rm -rf /home/claude/daggerheart-campaign-codex && git clone
https://<PAT>@github.com/whitwort/daggerheart-campaign-codex.git` →
verify HEAD matches this doc → set git identity → read `QOL-BACKLOG.md`
**and `phase-14-design.md`** (still the locked contract for S3–S7) before
any work.
