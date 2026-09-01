# HANDOFF — single rolling session-transfer doc

**Convention (established at repo cleanup, Aug 2026): this is the ONLY
session-transfer file.** Each session ends by REWRITING this file with
current state — do not create codex-handoff_N.md files. Old handoffs
(20–44) and the phase design docs (phase-14/15/17) were deleted from
the tree in the same cleanup; all remain retrievable from git history
(`git log --all --oneline -- 'codex-handoff_*.md' 'phase-*.md'`,
last present at the commit tagged v0.2b's successor). Code comments
citing e.g. "phase-14-design.md §5.1" are historical pointers into
those deleted docs — resolve via git history, don't "fix" the comments.

## Current state (end of session, Sep 1 2026, cont'd)

HEAD: `8327a94`. Deployed to **dev only**, CI green both commits below.
Prod still on v0.7b/`1a08007` — no Release cut today.

**This session (second half, after the deploy-hardening work already
folded into the section below): Encounters — Loot section, reveal-
timing toggles (captured, not yet wired), Run state machine.**

Scoped first: **Scene<->encounter relationship, confirmed with Gregg:
a Scene can have 0–many encounters; an encounter has 0–1 Scene.** No
implementation yet — this is the starting point for next session's
"Codex Scene <-> encounter-builder integration" work (see Open items).
AAR-style lore-item-on-conclusion is explicitly parked ("not sure
we're going that route") — don't build toward it without asking first.

Also scoped: what "auto-reveal on drop" for loot means, confirmed with
Gregg — a loot-list entry has no per-item "dropped" state; the whole
list is "what this encounter drops," and it drops (for the one wired
effect) when the encounter completes. The other three reveal-timing
toggles are explicitly INERT placeholders — Gregg: "I haven't told you
what those effect yet — that will be worked out in the Codex Scene
integration." Do not wire behavior to `revealAdversariesTiming` or
`revealLootOnCompletion` without checking that design first.

**Built (`d6bd6c1`, polish in `8327a94`):**
- `encounters/{id}` gains: `loot` (Equipment-entity instances, same
  picker/group shape as Adversaries, no per-instance play state),
  `lootAutoReveal` (bool, ACTIVE), `revealAdversariesTiming`
  ('off'|'start'|'completion', INERT), `revealLootOnCompletion` (bool,
  INERT), `runStatus` ('pristine'|'started'|'finished', stored not
  derived). All defaulted in `createEncounter`; old docs degrade via
  `|| []`/`|| 'pristine'` throughout, no migration needed.
- **Loot section** (Build tab): `+ Add loot` picker (Equipment
  category, subtype filter instead of Adversary's tier/type — armor/
  consumables/items/weapons vary wildly in `details` shape per
  srd-import.js, so the picker's summary line just joins whatever
  scalar `details` fields exist rather than hardcoding per-subtype).
  `lootAutoReveal` toggle: **the one wired behavior** — at Run
  completion, any loot entity still `visibility:'gm-only'` flips to
  `'all-players'` via one `writeBatch` (`revealHiddenLoot`).
- **Run state machine** (`runStatus`): pristine→started on Start click
  OR the first HP/Stress/condition mark via `patchInstance` — NOT from
  adding/removing adversaries or loot from either tab (deliberate
  scoping: roster assembly shouldn't itself declare the fight started;
  see `maybeAutoTransition`'s comment). started→finished on Complete
  click OR every adversary instance derived-defeated (reuses
  `buildInstanceRow`'s hpMax/hp>=hpMax check, via `isFullyDefeated`).
  {started,finished}→pristine on Reset (confirm dialog; zeroes every
  adversary instance's hp/stress/conditions; does NOT revert any
  visibility flips already made — a combat reset isn't an un-reveal).
  Start/Reset/Complete buttons render in the SAME flex row as the
  Build/Run tab buttons themselves (`tabsRow`), pushed right via
  `margin-left:auto` — sits above `tabsRow`'s border-bottom rather than
  inside either panel's content, per Gregg's spec.
- **UI polish** (`8327a94`, same-session feedback): the two reveal-
  timing toggles in each of Adversaries/Loot now share one row
  (`.encounter-reveal-row`, flex-wrap) instead of stacking. Run action
  buttons got hope border/glow-background (matches the app's existing
  hope-badge treatment) instead of flat void/border-line default
  button chrome.
- No `firestore.rules` changes — `encounters` stays fully
  `isGM()`-only (already covers new fields); the loot-reveal
  `writeBatch` only touches `entities.visibility`/`updatedAt`, both
  already `isValidEntity()`-whitelisted under the existing GM update
  rule. Rules unit tests re-ran clean (15/15) as a regression check,
  unaffected by this change.
- QOL-BACKLOG: new exception 24 for `.encounter-run-actions button`
  (width:auto, no sibling group — same family as exception 9).

**One initial confusion this session, resolved:** Gregg reported "no
new UI visible" right after the `d6bd6c1` dev deploy — matches the
app's own documented iOS Safari stale-JS-despite-fresh-build-hash
quirk (see Backup/restore section below, same root cause class).
Likely just needed a force-quit/Private-tab reload; wasn't a code bug
(CI was green, rules tests passed, gates all clean). Not confirmed
which it actually was — if it recurs, dig further instead of assuming
cache again.

**Next step / next session: scope the Codex Scene <-> encounter
integration.** Starting point: the confirmed 0-many/0-1 relationship
above, Phase 15 design doc §7's out-of-scope list (player-visible
encounter screen, AAR lore item — PARKED, archiving/duplicate,
settings UI), and the three inert reveal-timing toggles waiting for
real behavior. No data-model decisions made yet (e.g. does an
`encounters/{id}` doc get a `sceneId` field, or does the Scene entity
carry a list of encounter ids, or is it a join purely computed at
render time by filtering `state.allEncounters`?).

## Prior session (first half, same day): deploy-workflow hardening

HEAD at that point: `e31c930`. Approval gate explicitly skipped per
Gregg; rules unit tests + pre-deploy backup + post-deploy smoke test
built and verified in CI (dev job green end-to-end; prod job's new
steps — pre-deploy backup, post-deploy smoke test — still unverified,
first real run is whatever the next Release tag is).

1. `ae6db92` — `tests/rules/firestore.test.mjs` against
   `@firebase/rules-unit-testing` + local Firestore emulator. 15 cases:
   presence doc isolation, owned-Character create/update/self-release,
   the `character-edited` notification's split-recipient update
   clause, a stranger's `seenAt` attempt, `joinRequests` self-only
   create, default-deny. `npm run test:rules` wraps `firebase
   emulators:exec --only firestore`. New root-level `package.json`/
   `package-lock.json` — deliberately NO `"type":"module"` (would break
   `deploy.yml`'s existing inline `node -e ... require('firebase-
   admin')` steps); test file is `.mjs` instead. `firebase.json` gained
   `emulators.firestore.port`.
2. `41b02ca` — pre-deploy backup (exports prod Firestore to the private
   `whitwort/aethers-children-data` repo as `prod-release-<tag>.json`
   right before the Hosting deploy step, separate key file path from
   the deploy's own) + post-deploy smoke test (curls
   `https://daggerheart-campaign-codex.web.app` — Gregg-confirmed
   correct prod URL — after deploy, asserts the stamped build hash
   shows up, retries ~60s, fails the workflow if it never appears; no
   auto-rollback).
3. `e31c930` — CI fix: first live run failed both jobs ("firebase-tools
   no longer supports Java version before 21" — ubuntu-latest's default
   JDK too old for the Firestore emulator). Added
   `actions/setup-java@v4` (temurin, 21) before `firebase-tools`
   install, both jobs.

Earlier in this same session: reviewed pending TODOs — Gregg confirmed
prod SRD 2.0 migration done, presence/GM-notification QA done,
`firestore-backup.js` retry logic confirmed working. "Purge legacy
image docs" in dev: finished, just took a long time with the status
text stuck at "Scanning images…" (same long-polling-stall class as the
documented restore-path hangs, just on the READ side, never got a
watchdog — flagged in Backup/restore section below, not actioned).

## Correction (this session): Phase 15 was already fully built

The "Next: Phase 15 encounter-builder reimplementation" text that used
to sit in this doc across several rewrites was STALE — Phase 15 was
fully designed AND implemented Aug 21 2026 (`0fd29a0`..`7d8f203`, 12
commits), before this doc even had a "prod launch" entry. Tab shell,
rules, live listener, battle-point calculator, config row, difficulty
panel, per-instance HP/Stress tracking, adversary picker, environment
block, Build/Run tab split, condition selects, Run-view density pass —
all landed that day. Nobody caught the carried-forward text across
rewrites after the work was done. **Lesson for this file's own upkeep:
when starting a "next step" section, check git log for the named
commit/file FIRST, don't trust the last rewrite blindly** — this
session's Loot/Run-state/reveal-toggle work (above) is the genuinely
current state of the Encounters feature; everything below this point
in the doc is older history, kept for context.

## Prior session: focus-loss bug + backup retry (Aug 28 2026)

HEAD at end of that session: `a883ec4`.

Player-reported bug — entity edit form (Codex tab) loses focus/reverts
the instant you touch any field, dropdown included. Three commits:

1. `2c8f09a` — defensive-but-wrong-target fix: guarded codex.js's own
   `entities`/`loreItems`/`entityImages` `onSnapshot` handlers so a
   snapshot arriving mid-edit doesn't force the destructive
   `detailEl.innerHTML=''` rebuild while focus is inside the form.
   Deployed, retested, **did not fix it** — wrong listener.
2. `f577631` — actual trigger: `auth.js`'s `playerDocUnsub` (listens on
   `players/{email}`) called `updateAccessUI()` +
   `renderDetailForSelected()` unconditionally on EVERY snapshot of
   that doc — including `presence.js`'s heartbeat writes to that same
   doc's `lastOnline` field (on attach, every 4 min, and on every
   `visibilitychange` — iOS Safari fires that when a native `<select>`
   popup or the keyboard opens). GM has no `players/` doc → no
   heartbeat → player-only symptom, matching the report exactly.
   Patched to only re-render when role/`activeCharacterId` actually
   changed. This alone would have fixed it.
3. `a883ec4` — root-cause fix: split the heartbeat into its own
   `presence/{email}` doc instead of sharing `players/{email}`, so no
   future write to that doc can trigger this bug class again. New
   Firestore rule (`presence/{email}`: write-only `lastOnline`, own doc
   only, GM-only read), new `admin.js` `presenceUnsub` listener feeding
   `state.allPresence` (re-renders only the Status column). Also fixed
   the same bug's mirror image on the GM side while tracing it:
   `admin.js`'s old `players` listener called `renderCharactersTab()`
   on every snapshot too, so any player's heartbeat would have reset a
   GM's in-progress Characters-tab edit — never reported, caught by
   inspection. `presence` deliberately excluded from both backup
   scripts' `COLLECTIONS` (ephemeral, same reasoning as `_meta`). Old
   `players/{email}.lastOnline` fields are stale/orphaned — harmless,
   left in place.

**Retro (why 3 commits):** static analysis can't catch this bug class
— it's a runtime data-flow interaction through Firestore (write to doc
X → fires listener on doc X → triggers render), not a JS syntax/scope
issue. The real fix is architectural (separate docs for separate
write-frequency/consumer patterns) rather than tooling. A Playwright
player-role smoke test was floated (sign in as test player, open an
edit form, wait past a heartbeat/visibilitychange window, assert focus
survives) — still not built.

Also that session: `scripts/firestore-backup.js` had no retry logic —
a transient `RESOURCE_EXHAUSTED` killed a whole export. Added
`getWithRetry()`: 5 tries, exponential backoff, only for codes 8/14.
Confirmed working (Sep 1 session).

## Prior session: SRD 2.0 extraction complete, v0.7b (Aug 27 2026)

HEAD: `1a08007` = tag **v0.7b**, deployed to BOTH dev and prod.

- **SRD 2.0 extraction COMPLETE.** Adversaries (264) + environments (47)
  via `scripts/srd-extract/parse_adv.py` over `pdftohtml -xml -i`
  (inline styling → markdown; PUA tier/horde digits U+E53F..E549 → 0–9;
  ligature gaps fixed by a closed word list). 2.0's `Evolution` feature
  type passes through `normalizeFeatureRecord` (type is a free string).
- Character deck: Conditions tray → "Conditions / Transformations";
  picker offers both `Game Mechanics` subtypes grouped.
- Admin > Database > Backup > **Maintenance > Purge legacy image docs**:
  deletes exactly what `isRestorableImage` rejects. Run in dev this
  Sep-1 session — finished, but the status text sat at "Scanning
  images…" for a long time with no progress indicator.
- Release **v0.7b** created via API (tag pushed with git first — the
  Releases API 422s on a non-existent tag).

**Data flow rule (Gregg, Aug 27 2026): PROD IS THE SOURCE OF TRUTH.**
dev→prod backup/restore is no longer a route. Prod gets SRD updates via
Admin > Import from SRD > Update entries IN PROD. Dev is refreshed FROM
prod (prod Download backup → dev Wipe-and-replace). **Prod SRD 2.0
migration: DONE, confirmed by Gregg Sep 1.**

## Prior session: Phase-15 encounter workflow — designed AND built (Aug 21 2026)

Design doc `phase-15-encounter-workflow-design.md` is in git history
(`git log --all --oneline -- 'phase-*.md'`, locked at `ab9c3bc`).
Implementation: 12 commits `0fd29a0`..`7d8f203`, same day. Encounters
tab (GM-only, parallel to Characters), Firestore `encounters` collection
(GM read/write only), doc shape `{name, createdAt, updatedAt, partySize,
partyTier, highDamage, environmentId, instances[]}` with per-instance
`{entityId, fallbackName, label, hp, stress, note}` (note later replaced
by `conditions[]`, Phase 15 A2). Stats read live from the `entities`
cache, never denormalized. Battle-point calculator ported from the
sibling Apps Script encounter-builder as pure functions, hardcoded
constants (no settings UI — YAGNI). Adversary picker is a floating
panel with a picker-local search matcher extending feature-text/
difficulty matching the global codex index doesn't cover. Build/Run tab
split; condition selects per instance. **§7 out of scope, still open
except AAR (now explicitly parked, Sep 1):** player-visible encounter/
initiative screen; encounter archiving/duplicate; battle-value/
threshold settings UI.

## Prior session: Phase-14 features (Aug 24 2026)

Party presence (`presence.js` heartbeat, Admin > Manage Party Status
column) + GM notifications for player-initiated activity — commit
`48d09bf`. Presence later moved off `players/{email}` onto its own doc,
see Aug 28 session above (that's the current shape — do not re-add
`lastOnline` to `players/{email}`).
- **GM notifications for player-initiated activity:**
  - Owned-Character content edits → coalesced ONE notification per
    entity, refreshed in place on every edit (`sharing.js:
    notifyCharacterEdited`, doc id `charedit-{entityId}`). New
    `kind: 'character-edited'`; rules clause lets the OWNING player
    touch just `createdAt`/`seenAt` on that kind.
  - Notes/secrets a player shares further into the party → reuses
    `appendShareNotifications`; GM added as an extra `kind:'shared'`
    recipient ONLY when the share genuinely exposes a party member who
    didn't already have access.
  - `campaignUnreadCount`/`markCampaignSeen` generalized from a
    hardcoded `kind === 'joinRequest'` check to `recipientEmail ===
    self`.

**QA status: DONE, confirmed by Gregg Sep 1.**

## Prior session: prod launch (Aug 21 2026)

**Versioning:** the `VERSION` file is GONE. The Release tag is the
single source of truth: prod job derives `version = tag minus leading
"v"`. Publishing a Release IS the versioning act.

**Prod launch facts:**
- IAM (done): `codex-hosting-deploy` SA on prod has Cloud Datastore
  Index Admin + Cloud Datastore User.
- `BACKUP_REPO_PAT` fixed; daily prod→private-repo backup operational.
- Prod data complete except: 2 orphaned legacy image docs (deliberately
  skipped, see below) and thread message subcollections (client restore
  can't create them; Admin-SDK script only).

## Backup/restore: hard-won rules (backup.js)

The first prod restore failed four distinct ways; the fixes are load-
bearing — do not "simplify" them away:
1. Batches capped by BOTH count and ~1.5 MiB payload
   (`writeEntriesBatched`): a batched-write REQUEST caps ~10 MiB, and
   the forced long-polling transport (iOS fix, firebase.js) WEDGES on
   repeated multi-MiB commits — the promise never settles (no throw).
2. 45 s watchdog per commit + one rebuild-and-retry (WriteBatch is
   single-use). Steady state: a few timeouts per full restore, all
   recovering on first retry.
3. "restore engine rN" is the FIRST log line — bump it on any behavior
   change; it's how a stale-cached module is detected (**iOS Safari has
   served stale JS despite a fresh footer hash — force-quit Safari or
   use a Private tab.** Suspected same root cause behind this session's
   "no new UI visible" report right after the Loot/Run-state deploy —
   see Current State above, not fully confirmed).
4. `isRestorableImage` skips docs that can't pass isValidImage():
   currently 2 relics of the retired maps/ scheme.
5. Merge (non-wipe) mode wipes-and-recreates `notifications` first:
   notification UPDATES are recipient-locked (seenAt only), so set()
   on existing docs is denied even for GM.

**Note (Sep 1 2026): the "Purge legacy image docs" scan
(`backup.js`'s `getDocs(collection(db,'images'))`) shows the same
symptom class — a long, silent stall with no watchdog on the READ side
(the fixes above only cover the WRITE side). Ran successfully this
session but took a long time with a stuck-looking status message. If
this becomes a real complaint (not just slow-and-quiet), port the same
watchdog+retry pattern to the purge scan's `getDocs` call.**

Debugging heuristics that cracked the original restore bugs: wipe-phase
counts reveal what earlier runs actually wrote; replaying the chunking
algorithm against the dump's JSON sizes pinpoints which batch a run
died in; a log that just STOPS (no FAILED line) = hung promise, not a
throw.

## Recent fixes also in main

- Timeline cluster tap: `scale = min(sepScale, fitScale)` (70%
  viewport) — tight pair inside a wide span no longer zooms to an
  empty window.
- Full-repo review pass: dead code removed, picker-panel.js extraction,
  README rewrite, Leaflet self-hosted, modulepreload for all local
  modules + gstatic SDK (KEEP THE LIST IN SYNC when adding modules),
  hidden-panel render guards, 120 ms codex search debounce, debug
  banner is dev-only by design.

## Open items

- **Codex Scene <-> encounter-builder integration — THE live topic for
  next session.** Confirmed relationship: Scene 0–many encounters,
  encounter 0–1 Scene. AAR-on-conclusion is PARKED, don't build toward
  it unasked. The three inert reveal-timing toggles
  (`revealAdversariesTiming`, `revealLootOnCompletion`) are waiting on
  this design for their actual behavior. No data-model decisions made.
- Deploy-workflow hardening: rules tests / pre-deploy backup / post-
  deploy smoke test all BUILT (approval gate skipped per Gregg) — prod
  job's new steps unverified until the next Release. Watch that run.
- Post-launch optimizations: dynamic-import GM-only modules (~3k
  lines), codex.js split (4.8k lines, 5-module cycle), vendor/**
  long-cache header. Still just deferred exploration, not scoped.
- Single-entry restore "delete orphans" mode — deferred, needs a
  concrete use case before scoping (asked Gregg, not yet answered).
- Purge-legacy-image-docs scan has no watchdog on its `getDocs` read
  (see Backup/restore section) — low priority, only actually broken if
  it starts failing outright rather than just being slow.
- A Playwright player-role smoke test came up again during the Aug 28
  focus-loss retro — still just an idea, not built.
- The "no new UI visible" report this session, right after a dev
  deploy that CI confirmed was green — likely the documented iOS
  Safari stale-JS quirk, not confirmed. If it recurs, dig further
  before assuming cache again.

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code — and when
picking up a "Next step" from this file, check git log for any named
commit/file FIRST rather than trusting the text (see this doc's own
Phase-15 correction above — it happened once, don't let it happen
again). Gates before EVERY commit: named-import cross-check script
(regenerate from HANDOFF pattern if not persisted), `npx eslint@8
--no-eslintrc -c .eslintrc.check.json public/js/*.js`, `node --check`
per touched file, CSS + firestore.rules brace balance,
`npm run test:rules` if `firestore.rules` or its own test file
touched. Push via PAT URL; rebase FETCH_HEAD if remote moved. CI:
sleep ~74s then poll Actions API with PAT header. End every session by
rewriting THIS file.

HEAD at end of that session: `a883ec4`.

Player-reported bug — entity edit form (Codex tab) loses focus/reverts
the instant you touch any field, dropdown included. Three commits:

1. `2c8f09a` — defensive-but-wrong-target fix: guarded codex.js's own
   `entities`/`loreItems`/`entityImages` `onSnapshot` handlers so a
   snapshot arriving mid-edit doesn't force the destructive
   `detailEl.innerHTML=''` rebuild while focus is inside the form.
   Deployed, retested, **did not fix it** — wrong listener.
2. `f577631` — actual trigger: `auth.js`'s `playerDocUnsub` (listens on
   `players/{email}`) called `updateAccessUI()` +
   `renderDetailForSelected()` unconditionally on EVERY snapshot of
   that doc — including `presence.js`'s heartbeat writes to that same
   doc's `lastOnline` field (on attach, every 4 min, and on every
   `visibilitychange` — iOS Safari fires that when a native `<select>`
   popup or the keyboard opens). GM has no `players/` doc → no
   heartbeat → player-only symptom, matching the report exactly.
   Patched to only re-render when role/`activeCharacterId` actually
   changed. This alone would have fixed it.
3. `a883ec4` — root-cause fix: split the heartbeat into its own
   `presence/{email}` doc instead of sharing `players/{email}`, so no
   future write to that doc can trigger this bug class again. New
   Firestore rule (`presence/{email}`: write-only `lastOnline`, own doc
   only, GM-only read), new `admin.js` `presenceUnsub` listener feeding
   `state.allPresence` (re-renders only the Status column). Also fixed
   the same bug's mirror image on the GM side while tracing it:
   `admin.js`'s old `players` listener called `renderCharactersTab()`
   on every snapshot too, so any player's heartbeat would have reset a
   GM's in-progress Characters-tab edit — never reported, caught by
   inspection. `presence` deliberately excluded from both backup
   scripts' `COLLECTIONS` (ephemeral, same reasoning as `_meta`). Old
   `players/{email}.lastOnline` fields are stale/orphaned — harmless,
   left in place.

**Retro (why 3 commits):** static analysis can't catch this bug class
— it's a runtime data-flow interaction through Firestore (write to doc
X → fires listener on doc X → triggers render), not a JS syntax/scope
issue. The real fix is architectural (separate docs for separate
write-frequency/consumer patterns) rather than tooling. A Playwright
player-role smoke test was floated (sign in as test player, open an
edit form, wait past a heartbeat/visibilitychange window, assert focus
survives) — still not built.

Also that session: `scripts/firestore-backup.js` had no retry logic —
a transient `RESOURCE_EXHAUSTED` killed a whole export. Added
`getWithRetry()`: 5 tries, exponential backoff, only for codes 8/14.
**Confirmed working this session (Sep 1).**

## Prior session: SRD 2.0 extraction complete, v0.7b (Aug 27 2026)

HEAD: `1a08007` = tag **v0.7b**, deployed to BOTH dev and prod.

- **SRD 2.0 extraction COMPLETE.** Adversaries (264) + environments (47)
  via `scripts/srd-extract/parse_adv.py` over `pdftohtml -xml -i`
  (inline styling → markdown; PUA tier/horde digits U+E53F..E549 → 0–9;
  ligature gaps fixed by a closed word list; Volcanic Eruption is Tier 3
  per glyph + index despite the misplaced Tier 4 header on p.178). 2.0's
  `Evolution` feature type passes through `normalizeFeatureRecord` (type
  is a free string).
- Character deck: Conditions tray → "Conditions / Transformations";
  picker offers both `Game Mechanics` subtypes grouped.
- Admin > Database > Backup > **Maintenance > Purge legacy image docs**:
  deletes exactly what `isRestorableImage` rejects. **Run in dev this
  session (Sep 1) — finished, but the status text sat at "Scanning
  images…" for a long time with no progress indicator; see note above.**
- `setEntityImagesTarget` error handler now clears `entityImagesUnsub`/
  `entityImagesTargetId` so a dead listener reattaches on next render.
- Release **v0.7b** created via API (tag pushed with git first — the
  Releases API 422s on a non-existent tag).

**Data flow rule (Gregg, Aug 27 2026): PROD IS THE SOURCE OF TRUTH.**
dev→prod backup/restore is no longer a route. Prod gets SRD updates via
Admin > Import from SRD > Update entries IN PROD (idempotent by
category/subtype/slug). Dev is refreshed FROM prod (prod Download
backup → dev Wipe-and-replace) when dev data needs to match. **Prod
SRD 2.0 migration: DONE, confirmed by Gregg this session (Sep 1).**

## Prior session: Phase-15 encounter workflow — designed AND built (Aug 21 2026)

Design doc `phase-15-encounter-workflow-design.md` is in git history
(`git log --all --oneline -- 'phase-*.md'`, locked at `ab9c3bc`).
Implementation: 12 commits `0fd29a0`..`7d8f203`, same day. Encounters
tab (GM-only, parallel to Characters), Firestore `encounters` collection
(GM read/write only), doc shape `{name, createdAt, updatedAt, partySize,
partyTier, highDamage, environmentId, instances[]}` with per-instance
`{entityId, fallbackName, label, hp, stress, note}`. Stats read live
from the `entities` cache, never denormalized. Battle-point calculator
ported from the sibling Apps Script encounter-builder as pure functions
in `public/js/encounters.js`, hardcoded constants (no settings UI —
YAGNI). Adversary picker is a floating panel (gallery-picker precedent)
with a picker-local search matcher extending feature-text/difficulty
matching the global codex index doesn't cover. Build/Run tab split
inside the encounter detail pane; condition selects per instance.
**Out of scope, recorded in the design doc §7 (still open, nothing
built):** player-visible encounter/initiative screen; an AAR-style lore
item auto-generated on a scene when an encounter concludes; encounter
archiving/duplicate; battle-value/threshold settings UI.

**This is what "Codex Scene <-> encounter-builder integration" scoping
(next session) starts from** — the tracker itself exists; the gap is
connecting it back to Scene entities in the Codex.

## Prior session: Phase-14 features (Aug 24 2026)

Party presence (`presence.js` heartbeat, Admin > Manage Party Status
column) + GM notifications for player-initiated activity — commit
`48d09bf`. Presence later moved off `players/{email}` onto its own doc,
see Aug 28 session above (that's the current shape — do not re-add
`lastOnline` to `players/{email}`).
- **GM notifications for player-initiated activity:**
  - Owned-Character content edits → coalesced ONE notification per
    entity, refreshed in place on every edit (`sharing.js:
    notifyCharacterEdited`, doc id `charedit-{entityId}`). New
    `kind: 'character-edited'`; rules clause lets the OWNING player
    touch just `createdAt`/`seenAt` on that kind (recipientEmail is the
    GM, not the writer, so the general clause doesn't cover it).
  - Notes/secrets a player shares further into the party → reuses
    `appendShareNotifications`; GM added as an extra `kind:'shared'`
    recipient ONLY when the share genuinely exposes a party member who
    didn't already have access.
  - `campaignUnreadCount`/`markCampaignSeen` generalized from a
    hardcoded `kind === 'joinRequest'` check to `recipientEmail ===
    self`.

**QA status: DONE, confirmed by Gregg this session (Sep 1).**

## Prior session: prod launch (Aug 21 2026)

**Versioning:** the `VERSION` file is GONE. The Release tag is the
single source of truth: prod job derives `version = tag minus leading
"v"`. Publishing a Release IS the versioning act.

**Prod launch facts:**
- IAM (done): `codex-hosting-deploy` SA on prod has Cloud Datastore
  Index Admin + Cloud Datastore User.
- `BACKUP_REPO_PAT` fixed; daily prod→private-repo backup operational.
- Prod data complete except: 2 orphaned legacy image docs (deliberately
  skipped, see below) and thread message subcollections (client restore
  can't create them; Admin-SDK script only).

## Backup/restore: hard-won rules (backup.js)

The first prod restore failed four distinct ways; the fixes are load-
bearing — do not "simplify" them away:
1. Batches capped by BOTH count and ~1.5 MiB payload
   (`writeEntriesBatched`): a batched-write REQUEST caps ~10 MiB, and
   the forced long-polling transport (iOS fix, firebase.js) WEDGES on
   repeated multi-MiB commits — the promise never settles (no throw).
2. 45 s watchdog per commit + one rebuild-and-retry (WriteBatch is
   single-use). Steady state: a few timeouts per full restore, all
   recovering on first retry.
3. "restore engine rN" is the FIRST log line — bump it on any behavior
   change; it's how a stale-cached module is detected (iOS Safari has
   served stale JS despite a fresh footer hash — force-quit Safari or
   use a Private tab).
4. `isRestorableImage` skips docs that can't pass isValidImage():
   currently 2 relics of the retired maps/ scheme
   (map_A0351uUdz3yGyoJUqrdA_primary, map_ETX4fFFoCTcRLyvhCNFD_primary
   — ownerType:'map', role:'primary', no visibility).
5. Merge (non-wipe) mode wipes-and-recreates `notifications` first:
   notification UPDATES are recipient-locked (seenAt only), so set()
   on existing docs is denied even for GM.

**Note (Sep 1 2026): the "Purge legacy image docs" scan
(`backup.js`'s `getDocs(collection(db,'images'))`) shows the same
symptom class — a long, silent stall with no watchdog on the READ side
(the fixes above only cover the WRITE side). Ran successfully this
session but took a long time with a stuck-looking status message. If
this becomes a real complaint (not just slow-and-quiet), port the
same watchdog+retry pattern to the purge scan's `getDocs` call.**

Debugging heuristics that cracked the original restore bugs: wipe-phase
counts reveal what earlier runs actually wrote; replaying the chunking
algorithm against the dump's JSON sizes pinpoints which batch a run
died in; a log that just STOPS (no FAILED line) = hung promise, not a
throw.

## Recent fixes also in main

- Timeline cluster tap: `scale = min(sepScale, fitScale)` (70%
  viewport) — tight pair inside a wide span no longer zooms to an
  empty window.
- Full-repo review pass: dead code removed, picker-panel.js extraction,
  README rewrite, Leaflet self-hosted in public/vendor/leaflet/,
  modulepreload for all local modules + gstatic SDK (KEEP THE LIST IN
  SYNC when adding modules — comment in index.html), hidden-panel
  render guards (characters/encounters/stables), 120 ms codex search
  debounce, debug banner is dev-only by design.

## Open items

- **Codex Scene <-> encounter-builder integration — scoping starts
  next session.** Starting point: Phase 15 design doc §7 (player-visible
  encounter screen, AAR lore-item-on-conclusion, archiving/duplicate,
  settings UI). No decisions made yet.
- Deploy-workflow hardening: rules tests / pre-deploy backup / post-
  deploy smoke test all BUILT this session (approval gate explicitly
  skipped per Gregg) — prod job's new steps unverified until the next
  Release. Watch that run.
- Post-launch optimizations: dynamic-import GM-only modules (~3k
  lines), codex.js split (4.8k lines, 5-module cycle), vendor/**
  long-cache header. Still just deferred exploration, not scoped.
- Single-entry restore "delete orphans" mode — deferred, needs a
  concrete use case before scoping (asked Gregg, not yet answered).
- Purge-legacy-image-docs scan has no watchdog on its `getDocs` read
  (see Backup/restore section) — low priority, only actually broken if
  it starts failing outright rather than just being slow.
- A Playwright player-role smoke test (sign in as test player, exercise
  a form through a heartbeat/visibilitychange window) came up again
  during the Aug 28 focus-loss retro — still just an idea, not built.

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code — and when
picking up a "Next step" from this file, check git log for any named
commit/file FIRST rather than trusting the text (see this session's
Phase-15 correction above). Gates before EVERY commit: named-import
cross-check script (regenerate from HANDOFF pattern if not persisted),
`npx eslint@8 --no-eslintrc -c .eslintrc.check.json public/js/*.js`,
`node --check` per touched file, CSS + firestore.rules brace balance.
Push via PAT URL; rebase FETCH_HEAD if remote moved. CI: sleep ~74s
then poll Actions API with PAT header. End every session by rewriting
THIS file.
