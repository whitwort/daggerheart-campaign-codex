# Codex handoff 39 — Phase 17 (secrets discoverability + Lore Drops)

HEAD at session end: `4297a2f` (after this doc's commit, verify against
`git log`). Dev deploy CI green on `4297a2f`.

## What shipped (all pushed, dev-deployed)

- `3f8deb7` Phase 17 design doc
  (`phase-17-secrets-and-lore-drops-design.md` — read it first).
- `d077e2c` **Part A**: secret-children badge + Show secrets mode.
  - `entityHasSecretsFor(entity, ctx)` (visibility.js): entity itself
    OR any child loreItem/image in the green state
    (character-targeted at the viewer's active character, unshared).
  - New listener `characterImagesUnsub`: `images where
    visibility=='character'` — the one deliberate exception to the
    no-global-images-listener rule; base64 `data` field STRIPPED
    before storing in `state.allCharacterImages`.
  - "Show secrets"/"Show all" toggle in `#codex-list-actions`
    (player view incl. GM preview, only while secrets exist); borrows
    search's force-expand; seafoam mode chrome (inverted button +
    `#codex-entities.secrets-mode` ring/tint); mutually exclusive
    with search both directions; self-clears when last secret goes.
- `9a8b998` **Part B core**: Lore Drop recording.
  - `state.dropRecording = {changes, overlay}`; pure READ-TIME
    overlay: `resolveDropOverlay` applied at the top of
    visibility.js's read fns + the live toggle getters, so every
    surface reflects recorded state with no state-doc mutation
    (snapshot-proof). Clearing it on Save/Cancel reverts everything.
  - sharing.js `maybeRecordDropChange`: pure visibility patches
    ({visibility,characterId,characterShared} subset) are captured
    (original `from` preserved across re-toggles, states normalized)
    and the Firestore write skipped; dispatches
    `droprecording:change`. Combined content+visibility saves and
    `createLoreItemShared` write through (v1 limitation, in doc).
  - Recorder popup ("+ New drop", gmView-only, gallery-picker-panel
    chrome): live log via `buildDropChangeLine`/`buildDropStateBadge`
    (hidden = hope chip, visible = new fear `.entity-visible-badge`,
    character = badge), name input, Save/Cancel, no-op filtering,
    400-change cap. Save → `loreDrops` doc.
- `4297a2f` **Part B**: Stables tab + Run/Undo/Delete + notification.
  - New GM-only nav tab "Stables" (between Encounters and Admin; more
    residents planned). `public/js/stables.js`; `loreDropsUnsub`
    attached in auth.js's GM branch (invariant 1).
  - Run: one writeBatch — `to` per change (+updatedAt on
    entities/loreItems; bare patch on images; isMap image →
    mapImageVisibleToPlayers sync same batch), one consolidated
    `kind:'lore-drop'` notification per newly-exposed player
    (exposedEmailSet before/after diff, child→parent mapping gated on
    POST-drop parent canSee), status→'previous'. Undo: `from` per
    change + sync, →'current', silent. 500-op guard. Delete never
    reverts.
  - Rules: `loreDrops` GM-only block; notifications gain
    'lore-drop' + dropName/entityIds. Backup COLLECTIONS updated in
    BOTH `public/js/backup.js` and `scripts/firestore-backup.js`.
  - Campaign digest: player card "Lore drop: through *name* you have
    discovered [links…]" (canSee-gated links); GM summary card.
  - QOL exception 9 extended (`#codex-secrets-btn`,
    `#codex-new-drop-btn`).

## Not yet verified by Gregg (dev)

Entire Phase 17 needs live verification: secret badge on
entity/lore/image children; Show secrets enter/exit + search
interplay + preview mode; recording (toggle kebab/quick-toggle on all
three element types, re-toggle no-op filtering, visual revert on
Save/Cancel, map pins reflecting overlay); Stables list/detail;
Run → player notification wording + wiki links; Undo; isMap image in
a drop syncing the map icon; iPad layout of recorder panel + Stables.

## Known limitations / decisions (recorded in design doc)

- Combined content+visibility saves during recording bypass recording.
- Undo restores record-time `from` (clobbers interim manual edits).
- Undo silent; Run notification excludes the GM.
- Drop `from` staleness at Run: applied as recorded, not re-read.

## Watch items

- **Backup workflow failed on `79dc5b4`** (daily cron, pre-session) —
  check the Actions log.
- Two `entities` updates can land in one Run batch for the same doc
  (own change + isMap sync) — allowed by Firestore batches, ordered;
  fine but remember if refactoring.
- `changeElem` in stables.js reconstructs elements for
  exposedEmailSet — if that fn's read fields ever grow, extend the
  recorded change shape too (authorType/authorId already recorded for
  loreItems).

## Open items carried forward (unchanged)

Encounter-builder integration exploration (next topic per Gregg —
"return to how we will integrate the new Encounters builder/running
into the codex and player UX"); Phase 16 prod rollout go/no-go;
Firestore rules test matrix (§7 — loreDrops is another GM-only
two-liner, hand-verifiable; the notifications isValidNotification
change is slightly richer and SHOULD be eyeballed); player
self-release clause; player-facing JSON export; Phase 15 encounter
verification list from handoff 38.

## Session ritual reminder

Fresh clone, verify HEAD, git identity, read `QOL-BACKLOG.md` +
`phase-17-secrets-and-lore-drops-design.md` (+
`phase-15-encounter-workflow-design.md` when integration work
resumes). Import-check script before every commit. CI poll ~74s;
`json.loads(strict=False)`. Beware backticks in `git commit -m`
heredoc-less messages — use `-F -` with a quoted heredoc.
