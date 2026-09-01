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

## Current state (end of session, Aug 28 2026)

HEAD: `a883ec4`. Deployed to **dev only** (push-to-main auto-deploys dev;
no Release tag cut this session, so prod is still on v0.7b/`1a08007`).

**This session: player-reported bug — entity edit form (Codex tab) loses
focus / reverts the instant you touch any field, dropdown included.**
Three commits, in order of what was actually wrong:

1. `2c8f09a` — defensive-but-wrong-target fix: guarded codex.js's own
   `entities`/`loreItems`/`entityImages` `onSnapshot` handlers so a
   snapshot arriving mid-edit doesn't force the destructive
   `detailEl.innerHTML=''` rebuild while focus is inside the form
   (`safeRenderDetailForSelected`, defers to next `focusout`). Deployed,
   retested by Gregg, **did not fix it** — wrong listener.
2. `f577631` — actual trigger found: `auth.js`'s `playerDocUnsub`
   (listens on `players/{email}`) called `updateAccessUI()` +
   `renderDetailForSelected()` unconditionally on EVERY snapshot of that
   doc — including `presence.js`'s heartbeat writes to that same doc's
   `lastOnline` field (on attach, every 4 min, and on every
   `visibilitychange` — which iOS Safari fires when a native `<select>`
   popup or the keyboard opens). GM has no `players/` doc → no
   heartbeat → player-only symptom, matching the report exactly. Patched
   to only re-render when role/`activeCharacterId` actually changed.
   This alone would have fixed it.
3. `a883ec4` — root-cause fix, done at Gregg's request after a retro
   (see below): split the heartbeat into its own `presence/{email}` doc
   instead of sharing `players/{email}`, so no future write to that doc
   can ever trigger this class of bug again. New Firestore rule
   (`presence/{email}`: write-only `lastOnline`, own doc only, GM-only
   read), new `admin.js` `presenceUnsub` listener feeding
   `state.allPresence` (re-renders only the Status column, never
   `renderCharactersTab()`), `state.allPresence` added. Also fixed the
   **same bug's mirror image on the GM side** while tracing it:
   `admin.js`'s old `players` listener called `renderCharactersTab()` on
   every snapshot too, so any player's heartbeat would have reset a GM's
   in-progress Characters-tab edit — never reported, caught by
   inspection. `presence` deliberately excluded from both backup
   scripts' `COLLECTIONS` (ephemeral, same reasoning as `_meta`). Old
   `players/{email}.lastOnline` fields are stale/orphaned now — harmless,
   left in place (no cleanup pass).

**Retro discussion (why this took 3 commits):** static analysis
(ESLint/`node --check`) can't catch this class of bug — it's a runtime
data-flow interaction through Firestore (write to doc X → fires listener
on doc X → triggers render), not a JS syntax/scope issue. The real fix
is architectural (separate docs for separate write-frequency/consumer
patterns, done here) rather than tooling. Considered adding a Playwright
player-role smoke test to CI (sign in as test player, open an edit form,
wait past a heartbeat/visibilitychange window, assert focus survives) —
new infra, not yet built; revisit if this class of bug recurs.

**Also this session:** `scripts/firestore-backup.js` had no retry logic
— a transient `RESOURCE_EXHAUSTED` (backup run #22, Aug 27, coincided
with a heavy admin session: two SRD imports + a purge run) killed the
whole export. Added `getWithRetry()`: 5 tries, exponential backoff
(1/2/4/8s), only for codes 8 (`RESOURCE_EXHAUSTED`) / 14 (`UNAVAILABLE`)
— anything else rethrows immediately. Backup history otherwise clean
(8/22–8/26 all succeeded); not re-verified since (next cron or a manual
`workflow_dispatch` will confirm).

**Next step (Gregg):** retest the player edit-form fix (Characters →
Edit in Codex → open a dropdown / type in a field). Should be solid now
— `a883ec4` removes the trigger rather than filtering it.

**Carried over, unchanged from last session (still open):**
- Prod SRD 2.0 migration: in **prod**, Admin > Import from SRD > Update
  entries; spot-check one of each new type. (Dev's copy is done and
  confirmed good.)
- Manual QA pass on presence/GM-notification features (shipped v0.7b,
  never clicked through in the UI) — do this together with the above
  retest, same session.
- Click "Purge legacy image docs" in dev (UI exists, never run).

## Prior session: SRD 2.0 extraction complete, v0.7b (Aug 27 2026)

HEAD: `1a08007` = tag **v0.7b**, deployed to BOTH dev and prod (release
run green). Prod code is current; prod DATA is not yet (see next step).

**This session:**
- **SRD 2.0 extraction COMPLETE.** Adversaries (264) + environments (47)
  via new `scripts/srd-extract/parse_adv.py` over `pdftohtml -xml -i`
  (inline styling → markdown; PUA tier/horde digits U+E53F..E549 → 0–9;
  ligature gaps fixed by a closed word list; Volcanic Eruption is Tier 3
  per glyph + index despite the misplaced Tier 4 header on p.178). Output
  matches 1.0 upstream shape on shared records modulo typography. 2.0's
  `Evolution` feature type passes through `normalizeFeatureRecord` (type
  is a free string). Status table in `docs/srd-update-process.md` all
  done. Gregg ran Update entries in dev and confirmed parse looks good.
- **Bug found by that import:** dev `config/campaign.srdRepo` still held
  `seansbox/daggerheart-srd`, so the first Update entries run pulled 1.0
  data from GitHub (770 overwritten with 1.0, 4 new types 404). Fixed
  `5b4ce5c`: Admin SRD source is a `<select>` with only `local`; map.js
  normalizes a stored seansbox value to `local`. Re-run in dev restored
  2.0 content.
- Character deck: Conditions tray → "Conditions / Transformations";
  picker offers both `Game Mechanics` subtypes grouped, same
  `cards.conditions` array (`CONDITION_SUBTYPES` in character-deck.js).
- Admin > Database > Backup > **Maintenance > Purge legacy image docs**:
  deletes exactly what `isRestorableImage` rejects (GM delete needs no
  validation). Closes the "Admin-SDK script only" item. NOT yet run in
  dev — Gregg to click it once.
- `setEntityImagesTarget` error handler now clears `entityImagesUnsub`/
  `entityImagesTargetId` so a dead listener reattaches on next render.
- Release **v0.7b** created via API (tag pushed with git first — the
  Releases API 422s on a non-existent tag; note for next time).

**Data flow rule (Gregg, Aug 27 2026): PROD IS THE SOURCE OF TRUTH.
dev→prod backup/restore is no longer a route.** Prod gets SRD 2.0 by
running Admin > Import from SRD > Update entries IN PROD (idempotent by
category/subtype/slug; source select is `local` — a stale stored
seansbox value is normalized to local by map.js, so it's safe). Dev is
refreshed FROM prod (prod Download backup → dev Wipe-and-replace) when
dev data needs to match. "Purge legacy image docs" is a dev-only chore.

**Next step (Gregg):** in prod, Admin > Import from SRD > Update entries;
spot-check one of each new type.

**Still open:** manual QA pass on presence/GM notifications (shipped in
v0.7b untested — QA in prod now counts).

## Next: Phase 15 encounter-builder reimplementation

Design doc `phase-15-encounter-workflow-design.md` is in git history
(`git log --all --oneline -- 'phase-*.md'`). Encounters tab, Firestore
`encounters` collection, per-instance HP/Stress, Run tab with full stat
blocks. Adversary/environment data is now 2.0 and local; the sibling
Apps Script encounter-builder is the reference for the difficulty
calculator (SRD 2.0 Battle Points table is on p.94 of the PDF — check it
against the builder's constants before porting).

## Prior session: Phase-14 features (Aug 24 2026)

Party presence (`presence.js` heartbeat, Admin > Manage Party Status
column) + GM notifications for player-initiated activity (character
edits, shares that expose new party members) — single commit `48d09bf`.
- **Party presence**: originally `players/{email}.lastOnline`, written
  by `presence.js` heartbeat (stamp on attach/tab-foreground + 4 min
  interval while a player's tab is open; GM has no `players/` doc, so
  player-only). **Moved to its own `presence/{email}` doc Aug 28 2026**
  — see Current State above; sharing the doc with role/activeCharacterId
  caused a focus-loss bug in the entity edit form. Admin > Manage Party
  has a **Status** column — "Online" (stamp <5 min old), "Last online
  \<local date/time\>", or "Never online" — computed at render time,
  no refresh timer (same staleness tradeoff the Messages digest's
  relative-time already carries; consistent with existing precedent,
  not a new pattern).
- **GM notifications for player-initiated activity** (previously
  invisible to the GM):
  - Owned-Character content edits (sheet/deck/level/gold/main edit
    form) → coalesced ONE notification per entity, refreshed in place
    on every edit (`sharing.js: notifyCharacterEdited`, doc id
    `charedit-{entityId}`, upserted via `setDoc(..., {merge:true})`).
    New `kind: 'character-edited'`; new rules clause lets the OWNING
    player (not the recipient GM) touch just `createdAt`/`seenAt` on
    that specific kind — the general recipient-updates-seenAt clause
    didn't cover this since recipientEmail is the GM, not the writer.
  - Notes/secrets a player shares further into the party → reuses the
    existing `appendShareNotifications` exposure fan-out; GM added as
    an extra `kind:'shared'` recipient ONLY when the share genuinely
    exposes a party member who didn't already have access (Gregg's
    explicit call — a share that exposes nobody new, e.g. a private
    note aimed only at the GM, or re-sharing something already
    party-visible, does NOT notify). No rules change needed (`shared`
    kind/shape was already valid).
  - `campaignUnreadCount`/`markCampaignSeen` (messages.js) generalized
    from a hardcoded `kind === 'joinRequest'` check to
    `recipientEmail === self`, so both old (joinRequest) and new
    (character-edited, GM-directed shared) kinds count toward GM
    unread without another special case later.
- `index.html` modulepreload list updated (`presence.js` inserted
  alphabetically). All 5 owned-entity write sites hooked:
  `character-sheet.js` ×2, `character-deck.js`, `characters.js`,
  `codex.js`'s `saveEntityEdit`.

**NOT yet done from this feature set:** no manual QA pass in the dev
UI (session moved straight to SRD ingest per Gregg) — worth a quick
click-through of Admin > Manage Party Status and a player-side
edit/share before the next Release tag.

## Prior session: prod launch (Aug 21 2026)

Latest main from that session additionally carries: merge-mode
notifications fix, tag-derived versioning (below), full-repo cleanup.

**Versioning (changed!):** the `VERSION` file is GONE. The Release tag
is the single source of truth: prod job derives `version = tag minus
leading "v"`. Publishing a Release IS the versioning act — bump
nothing beforehand. Dev deploys still label as `build <hash> (dev)`.
Next release: tag `v0.2c` (or whatever's next) — footer and
`_meta/version` will match automatically.

**Prod launch facts:**
- IAM (done): `codex-hosting-deploy` SA on prod has Cloud Datastore
  Index Admin + Cloud Datastore User (prod deploy 403s without them).
- `BACKUP_REPO_PAT` fixed; daily prod→private-repo backup operational.
- Prod data complete except: 2 orphaned legacy image docs
  (deliberately skipped, see below) and thread message subcollections
  (client restore can't create them; Admin-SDK script only).

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
   — ownerType:'map', role:'primary', no visibility). QOL: purge from
   dev someday (no UI path; Admin-SDK script).
5. Merge (non-wipe) mode wipes-and-recreates `notifications` first:
   notification UPDATES are recipient-locked (seenAt only), so set()
   on existing docs is denied even for GM.
Debugging heuristics that cracked it: wipe-phase counts reveal what
earlier runs actually wrote; replaying the chunking algorithm against
the dump's JSON sizes pinpoints which batch a run died in; a log that
just STOPS (no FAILED line) = hung promise, not a throw.

## Recent fixes also in main

- Timeline cluster tap: `scale = min(sepScale, fitScale)` (70%
  viewport) — tight pair inside a wide span no longer zooms to an
  empty window. Verified desktop + iPad.
- Full-repo review pass (6 commits, was handoffs 43): dead code
  removed, picker-panel.js extraction, README rewrite, Leaflet
  self-hosted in public/vendor/leaflet/, modulepreload for all local
  modules + gstatic SDK (KEEP THE LIST IN SYNC when adding modules —
  comment in index.html), hidden-panel render guards
  (characters/encounters/stables), 120 ms codex search debounce,
  debug banner is dev-only by design (projectId -dev or unstamped).

## Open items

- Click Purge legacy image docs in dev (UI now exists).
- Deploy-workflow hardening: approval gate, rules unit tests,
  pre-deploy backup, post-deploy smoke test — decide priority. (A
  player-role Playwright smoke test came up again this session re: the
  focus-loss bug retro — still not built, still just an idea.)
- Post-launch optimizations: dynamic-import GM-only modules (~3k
  lines), codex.js split (4.8k lines, 5-module cycle), vendor/**
  long-cache header.
- Encounter-builder integration exploration; single-entry restore
  "delete orphans" mode — both deferred.
- Manual QA pass on presence/GM-notification features (shipped in
  v0.7b) — bundle with retesting the Aug 28 focus-loss fix.
- Confirm firestore-backup.js's new retry logic actually helps: next
  cron run or a manual workflow_dispatch will tell.

## Session ritual

Fresh clone to /tmp with PAT-embedded URL; git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: /tmp/import-check.py (named-import cross-check), `npx
eslint@8 --no-eslintrc -c .eslintrc.check.json public/js/*.js`,
`node --check` per file, CSS + firestore.rules brace balance. Push via
PAT URL; rebase FETCH_HEAD if remote moved. CI: sleep ~74 s then poll
Actions API with PAT header, json.loads(strict=False). End every
session by rewriting THIS file.
