# Codex handoff 41 — cleanup pass + single-entry restore

HEAD at session end: `6d7896d` (before this doc's commit; verify
actual HEAD with `git log` at next session start). All commits pushed,
dev deploy CI green on every push. Two of the commits below
(`035756d`, `de78d59`/`c24b3a3`) were Gregg's own direct-to-GitHub
edits, rebased in mid-session — not otherwise described here.

Opened with cumulative-dev-list verification against handoff 40
(clean — HEAD matched expectations) before moving to a run of small
cleanup items Gregg brought up one at a time, then one feature.

## What shipped

- **Wiki-linking investigation — no bug, no code change.** Two
  reported symptoms ("Aether Weave" never links) both turned out to
  be correctly-behaving edge cases: (1) self-link suppression on the
  entry's own page (an entity is deliberately excluded from its own
  candidate list), (2) inflection mismatch — "Weavers"/"Weaving" in
  the source text aren't literally "Weave", and the boundary-checked
  matcher doesn't do stemming. Confirmed via `applyWikiLinks`
  (codex.js) longest-match-first logic tested correctly in isolation
  (jsdom simulation) before either explanation was reached.
- `8708d4f` **Search: numeric substring collision.** `entityMatchesQuery`'s
  `indexMatch` did a plain substring search against `searchIndex`
  entries ("level 1", "level 10", ...), so "level 1" matched "level
  10" too. Added a trailing word-boundary check (character after the
  match, if any, must not be alphanumeric). Scoped to `indexMatch`
  only per Gregg — name/tag/alias matching left alone pending
  usability testing.
- `0a36dc0` **Meta-details leftover joiner bug.** `resolveLoreItemMarkdown`
  always joined synthesized Details bullets to leftover SRD content
  with a single `\n`, assuming leftover is always more bullets (e.g.
  weapon Damage). The common case — an ability's freeform `text`
  field — is prose, which triggers CommonMark lazy-continuation
  (merges into the last bullet, no visual break) and, if that prose
  later contains its own bullet list (e.g. "Bare Bones"' Tier
  thresholds), forces the WHOLE preceding list into loose-list
  rendering (every item wrapped in `<p>`, visible extra gaps).
  Fixed: joiner is now content-aware — `\n` only when leftover itself
  starts with a bullet marker, else `\n\n`. Verified against both of
  Gregg's screenshots via a real `marked.js` render before writing the
  fix.
- `c4de40c` **Lore block code/pre styling.** `.lore-item-body code`/`pre`
  had inherited the app's generic monospace/technical treatment —
  wrong register for lore prose, where backtick spans read as an
  inscription/quoted-term convention, not code. Switched to
  `var(--font-quote)` (Varela Round, matching the existing blockquote
  font-swap), bumped size/weight, re-tinted toward the Hope palette
  (gold) rather than blockquote's neutral ink-soft, so the two read as
  siblings. Scoped to `.lore-item-body` only — Admin/Messages/
  gallery-picker/search-help keep the technical monospace styling.
- `d03e91f` + `5ec7260` **Admin > Data > Backup: restore a single
  entry.** New section below the existing full-dump restore: own file
  upload, filterable entity picker (reuses `entityMatchesQuery` +
  `categoryGroupLabel` from codex.js against the dump's entity list),
  preview shows loreItem/pin/image counts found for the selected
  entity, then a scoped write of just that entity doc + its loreItems
  (`entityId`) + pins (`entityId`) + images (`ownerId`). v1 is
  additive/overwrite-by-id only, per Gregg — doesn't delete any live
  docs absent from the backup. **Shipped with a bug, fixed same
  session**: `entryRestoreEntityPool` flattens each dump entry to
  `{ id, ...data }` for the picker UI, and the first version of
  `runEntryRestore` wrote that WHOLE flattened object — `id` included
  — as the document body. `id` isn't in `isValidEntity()`'s
  `keys().hasOnly([...])` whitelist, so the entity write was rejected
  regardless of GM status ("Missing or insufficient permissions"),
  even though the rules themselves were fine and Old Sularia's actual
  field set was 100% within the whitelist. Fix: strip `id` before
  writing. loreItems/pins/images entries were never affected — they
  come straight from the dump's raw `{id, data}` entries, never
  flattened.
- `6d7896d` **entity-images-cache.js: permanently-stuck listener
  bug.** Reported as "Map tab portraits don't always populate until
  the same entity's been viewed on Codex" — hard to reproduce, "more
  common in Well C". Root cause: the per-target images-cache
  listener's error callback only logged, never reset `unsub`.
  `setTarget`'s guard (`targetId === entityId && unsub`) then treats
  that entity as permanently subscribed once `unsub` is truthy, dead
  listener or not — any transient `onSnapshot` error (or a retarget
  racing an in-flight snapshot callback) leaves the portrait blank for
  that entity for the rest of the session, and every later re-tap of
  the same pin is a silent no-op. Explains "Well C more than Well B":
  Well C retargets on every pin tap; Well B only once per map load, so
  it has far less exposure to the race. The "fixed after viewing
  Codex" correlation was very likely coincidence — some unrelated
  `notifyVisibilityChange` elsewhere re-rendered the pane and just
  happened to land after other unrelated activity, not because Codex
  itself did anything for Map's independent cache. Fix: null `unsub`
  in the error callback so the next `setTarget` for that id actually
  retries. **Flagged, not fixed**: `setEntityImagesTarget` (codex.js,
  the Codex tab's own images cache) has the identical structural gap.
  Left alone — lower exposure, out of scope for this fix. Worth a
  same-shaped patch if Gregg ever sees the symptom on Codex itself.

## Needs Gregg's dev verification

- Single-entry restore: re-test "Old Sularia" now that the `id`-strip
  fix is in; try an entity with 0 lore items/pins/images (empty-plan
  edge case untested), and one with a large image (base64 payload
  size — restore batches by BATCH_LIMIT chunks but a single doc near
  Firestore's 1MB limit was never specifically exercised this
  session).
- Map Well C portrait fix: given "difficult to reproduce" going in,
  this may take a while in normal play to confirm fixed rather than
  just less frequent. Worth keeping an eye on specifically after
  rapid pin-tapping sessions.
- Lore code/pre styling: gold tint vs. existing Hope-track color
  elsewhere in the UI — flag if it reads too close, or if pre blocks
  want to be visually heavier/lighter.
- Search index boundary fix: quick spot-check that ordinary substring
  queries ("bone" -> "bone domain") still behave, since the fix only
  touched the boundary condition, not the substring match itself.

## Open items carried forward

- **Encounter-builder integration into codex/player UX** — still the
  standing next-phase topic (handoff 40's opening item), not touched
  this session; this was entirely a cleanup/bugfix/small-feature
  session instead, at Gregg's redirect. Reload
  `phase-15-encounter-workflow-design.md` alongside
  `phase-17-secrets-and-lore-drops-design.md` next time this comes up
  — scope is still: (1) Run-tab combat lifecycle (start/end-of-combat
  scene visibility changes + AAR-style lore item), (2) loot path
  (encounter reward Equipment -> `type:'loot'` drop, run at combat
  end), (3) player-visible encounter/initiative screen (currently zero
  player surface), (4) encounter archiving/duplicate (low priority).
- Phase 16 prod rollout go/no-go — still pending, not raised this
  session.
- Backup cron PAT rotation (diagnosed handoff 40, deferred until after
  first Phase 16 prod deploy) — not raised this session either.
- `setEntityImagesTarget`'s identical stuck-listener gap (above) — fix
  if/when it actually bites on Codex.
- Possible future "delete orphans" mode for single-entry restore (full
  revert-to-backup-state) — explicitly deferred by Gregg for v1.

## Key learnings (this session)

- **Debugging a "why doesn't X link/match" report**: always reproduce
  the matcher logic in isolation first (plain Node, or jsdom for DOM-
  walking code) against the reported example BEFORE looking for a
  bug in the surrounding system (visibility, caching, data). Saved a
  lot of wrong turns this session — the wiki-link investigation could
  easily have gone down a visibility-gating rabbit hole before the
  screenshots revealed it was self-suppression + inflection mismatch,
  not a bug at all.
- **Any per-target Firestore listener cache with a `setTarget`-style
  guard needs its error callback to reset the "already subscribed"
  flag**, not just log. Two instances of this exact shape exist now
  (`entity-images-cache.js` fixed, `codex.js`'s `setEntityImagesTarget`
  flagged); worth checking for a third pattern if any future caching
  module follows the same shape.
- **When a Firestore write is rejected with "Missing or insufficient
  permissions" for a GM (who should always pass `isGM()`), check the
  document SHAPE against `firestore.rules`' `isValid*()` functions
  before assuming an auth/rules problem** — `keys().hasOnly([...])`
  rejects on ANY unexpected key, including keys added by the client
  code itself for its own UI convenience (like a flattened `id` field)
  that were never meant to reach the document body.
- Backup-restore code paths (full-dump and single-entry) both write
  through the exact same `isValidEntity()`/`isValidLoreItem()`/
  `isValidImage()` rules as live GM edits — a backup is not a
  privileged bypass. Any doc that predates a schema tightening and
  hasn't been re-saved since will fail to restore until manually
  brought current, same as it would fail a live edit.

## Session ritual reminder

Fresh clone, verify HEAD, git identity,
`git rebase FETCH_HEAD` if the remote has moved (happened three times
this session from Gregg's direct GitHub-web edits — rebase cleanly
each time, no conflicts). Read `QOL-BACKLOG.md` +
`phase-17-secrets-and-lore-drops-design.md` +
`phase-15-encounter-workflow-design.md` before the encounter-builder
integration topic. Import-check script + eslint + `node --check` +
CSS brace balance before every commit. CI poll ~74s;
`json.loads(strict=False)`.
